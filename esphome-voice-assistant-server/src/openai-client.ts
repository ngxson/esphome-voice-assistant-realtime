import WebSocket from 'ws';
import { Config } from './config.js';
import { ConversationItem } from './session-manager.js';
import { OpenAITool } from './mcp-client.js';
import { WavRecorder } from './audio-recorder.js';

export type AudioOutputCallback = (audio: Buffer) => void;
export type DisconnectCallback = () => void;
export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

// Built-in tool that lets the AI end the conversation
const DISCONNECT_TOOL: OpenAITool = {
  type: 'function',
  name: 'disconnect_client',
  description: 'Disconnect the client when the conversation is complete or the user requests to stop.',
  parameters: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        enum: ['user_requested_stop', 'conversation_ended'],
        description: 'Reason for ending the conversation.',
      },
    },
    required: ['reason'],
  },
};

interface PendingFunctionCall {
  name: string;
  argsBuffer: string;
}

export class OpenAIRealtimeClient {
  private ws: WebSocket | null = null;
  private config: Config;
  private tools: OpenAITool[];
  private onAudio: AudioOutputCallback;
  private onDisconnect: DisconnectCallback;
  private onToolCall: ToolCallHandler;

  private conversationItems: ConversationItem[];
  private pendingFunctionCalls = new Map<string, PendingFunctionCall>();
  private sessionReady = false;

  private inputRecorder: WavRecorder | null = null;
  private outputRecorder: WavRecorder | null = null;

  constructor(
    config: Config,
    tools: OpenAITool[],
    cachedItems: ConversationItem[],
    recordingPath: string | null,
    onAudio: AudioOutputCallback,
    onDisconnect: DisconnectCallback,
    onToolCall: ToolCallHandler,
  ) {
    this.config = config;
    this.tools = tools;
    this.conversationItems = [...cachedItems];
    this.onAudio = onAudio;
    this.onDisconnect = onDisconnect;
    this.onToolCall = onToolCall;

    if (recordingPath) {
      this.inputRecorder = new WavRecorder(`${recordingPath}_input.wav`);
      this.outputRecorder = new WavRecorder(`${recordingPath}_output.wav`);
    }
  }

  connect(): Promise<void> {
    const url = `wss://api.openai.com/v1/realtime?model=${this.config.model}`;
    this.ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.config.openai_api_key}`,
      },
    });

    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.ws!.once('error', onError);

      this.ws!.on('open', () => {
        this.configureSession();
      });

      this.ws!.on('message', (raw) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        this.handleEvent(event, () => {
          this.ws!.removeListener('error', onError);
          resolve();
        });
      });

      this.ws!.on('close', () => {
        this.closeRecorders();
        this.onDisconnect();
      });

      this.ws!.on('error', (err) => {
        console.error('[OpenAI] WebSocket error:', err.message);
      });
    });
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.config.instructions,
        voice: this.config.voice,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: this.config.vad_threshold,
          prefix_padding_ms: this.config.vad_prefix_padding_ms,
          silence_duration_ms: this.config.vad_silence_duration_ms,
        },
        tools: [DISCONNECT_TOOL, ...this.tools],
        tool_choice: 'auto',
      },
    });
  }

  private handleEvent(event: Record<string, unknown>, onReady: () => void): void {
    const type = event.type as string;

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        if (!this.sessionReady) {
          this.sessionReady = true;
          this.restoreContext();
          onReady();
        }
        break;
      }

      case 'response.audio.delta': {
        const audio = Buffer.from(event.delta as string, 'base64');
        this.outputRecorder?.write(audio);
        this.onAudio(audio);
        break;
      }

      // GA API renamed this event; handle both names for safety
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done': {
        const transcript = event.transcript as string;
        if (transcript) {
          this.conversationItems.push({ type: 'message', role: 'assistant', content: transcript });
        }
        break;
      }

      case 'conversation.item.created': {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.role === 'user' && Array.isArray(item.content)) {
          for (const part of item.content as Array<Record<string, unknown>>) {
            const text = (part.text ?? part.transcript) as string | undefined;
            if (text) {
              this.conversationItems.push({ type: 'message', role: 'user', content: text });
              break;
            }
          }
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const callId = event.call_id as string;
        if (!this.pendingFunctionCalls.has(callId)) {
          this.pendingFunctionCalls.set(callId, { name: event.name as string, argsBuffer: '' });
        }
        (this.pendingFunctionCalls.get(callId) as PendingFunctionCall).argsBuffer += event.delta as string;
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string;
        const name = event.name as string;
        const argsJson = event.arguments as string;
        this.pendingFunctionCalls.delete(callId);
        void this.executeTool(callId, name, argsJson);
        break;
      }

      case 'error': {
        const err = event.error as Record<string, unknown>;
        console.error('[OpenAI] Error event:', err?.message ?? event.error);
        break;
      }
    }
  }

  private async executeTool(callId: string, name: string, argsJson: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      // malformed JSON — proceed with empty args
    }

    console.log(`[OpenAI] Tool call: ${name}(${argsJson})`);

    if (name === 'disconnect_client') {
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: 'Disconnected.' },
      });
      this.onDisconnect();
      return;
    }

    let output: string;
    try {
      output = await this.onToolCall(name, args);
    } catch (err: unknown) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    this.conversationItems.push({ type: 'function_call', name, call_id: callId, arguments: argsJson });
    this.conversationItems.push({ type: 'function_call_output', call_id: callId, output });

    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.send({ type: 'response.create' });
  }

  private restoreContext(): void {
    if (this.conversationItems.length === 0) return;

    for (const item of this.conversationItems) {
      if (item.type !== 'message') continue;
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: item.role,
          content: [{ type: item.role === 'user' ? 'input_text' : 'text', text: item.content }],
        },
      });
    }
    console.log(`[OpenAI] Restored ${this.conversationItems.length} context items`);
  }

  sendAudio(pcm: Buffer): void {
    if (!this.sessionReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.inputRecorder?.write(pcm);
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  interrupt(): void {
    this.send({ type: 'response.cancel' });
    this.send({ type: 'input_audio_buffer.clear' });
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private closeRecorders(): void {
    this.inputRecorder?.close().catch(console.error);
    this.outputRecorder?.close().catch(console.error);
    this.inputRecorder = null;
    this.outputRecorder = null;
  }

  private send(event: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }
}
