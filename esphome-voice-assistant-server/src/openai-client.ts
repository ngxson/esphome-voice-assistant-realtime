import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/beta/realtime/ws';
import { Config } from './config.js';
import { ConversationItem } from './session-manager.js';
import { OpenAITool } from './mcp-client.js';
import { WavRecorder } from './audio-recorder.js';

export type AudioOutputCallback = (audio: Buffer) => void;
export type DisconnectCallback = () => void;
export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

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

export class OpenAIRealtimeClient {
  private rt: OpenAIRealtimeWS | null = null;
  private config: Config;
  private tools: OpenAITool[];
  private onAudio: AudioOutputCallback;
  private onDisconnect: DisconnectCallback;
  private onToolCall: ToolCallHandler;

  private conversationItems: ConversationItem[];
  private sessionReady = false;
  // call_id → function name, populated from response.output_item.added
  private pendingCallNames = new Map<string, string>();

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
    const client = new OpenAI({ apiKey: this.config.openai_api_key });

    return new Promise((resolve, reject) => {
      this.rt = new OpenAIRealtimeWS({ model: this.config.model }, client);
      const rt = this.rt;

      rt.socket.on('open', () => {
        this.configureSession();
      });

      rt.on('session.created', () => {
        if (!this.sessionReady) {
          this.sessionReady = true;
          this.restoreContext();
          resolve();
        }
      });

      rt.on('session.updated', () => {
        if (!this.sessionReady) {
          this.sessionReady = true;
          this.restoreContext();
          resolve();
        }
      });

      rt.on('response.audio.delta', (event) => {
        const audio = Buffer.from(event.delta, 'base64');
        this.outputRecorder?.write(audio);
        this.onAudio(audio);
      });

      rt.on('response.audio_transcript.done', (event) => {
        if (event.transcript) {
          this.conversationItems.push({ type: 'message', role: 'assistant', content: event.transcript });
        }
      });

      rt.on('conversation.item.created', (event) => {
        const item = event.item;
        if (item.role === 'user' && Array.isArray(item.content)) {
          for (const part of item.content) {
            const text = ('text' in part ? part.text : undefined)
              ?? ('transcript' in part ? part.transcript : undefined);
            if (text) {
              this.conversationItems.push({ type: 'message', role: 'user', content: text });
              break;
            }
          }
        }
      });

      // Capture the function name when the output item is first added
      rt.on('response.output_item.added', (event) => {
        const item = event.item;
        if (item.type === 'function_call' && item.call_id && item.name) {
          this.pendingCallNames.set(item.call_id, item.name);
        }
      });

      rt.on('response.function_call_arguments.done', (event) => {
        const name = this.pendingCallNames.get(event.call_id) ?? '';
        this.pendingCallNames.delete(event.call_id);
        void this.executeTool(event.call_id, name, event.arguments);
      });

      rt.on('error', (err) => {
        console.error('[OpenAI] Error event:', err.message);
      });

      rt.socket.on('close', () => {
        this.closeRecorders();
        this.onDisconnect();
      });

      rt.socket.on('error', (err: Error) => {
        console.error('[OpenAI] Socket error:', err.message);
        reject(err);
      });
    });
  }

  private configureSession(): void {
    this.rt!.send({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.config.instructions,
        voice: this.config.voice as 'alloy' | 'echo' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage' | 'verse',
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

  private async executeTool(callId: string, name: string, argsJson: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argsJson) as Record<string, unknown>;
    } catch {
      // malformed args — proceed with empty object
    }

    console.log(`[OpenAI] Tool call: ${name}(${argsJson})`);

    if (name === 'disconnect_client') {
      this.rt?.send({
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

    this.rt?.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.rt?.send({ type: 'response.create' });
  }

  private restoreContext(): void {
    if (this.conversationItems.length === 0) return;

    for (const item of this.conversationItems) {
      if (item.type !== 'message') continue;
      this.rt!.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: item.role as 'user' | 'assistant',
          content: [
            item.role === 'user'
              ? { type: 'input_text', text: item.content ?? '' }
              : { type: 'text', text: item.content ?? '' },
          ],
        },
      });
    }
    console.log(`[OpenAI] Restored ${this.conversationItems.length} context items`);
  }

  sendAudio(pcm: Buffer): void {
    if (!this.sessionReady || !this.rt) return;
    this.inputRecorder?.write(pcm);
    this.rt.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  interrupt(): void {
    this.rt?.send({ type: 'response.cancel' });
    this.rt?.send({ type: 'input_audio_buffer.clear' });
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  close(): void {
    this.rt?.close();
    this.rt = null;
  }

  private closeRecorders(): void {
    this.inputRecorder?.close().catch(console.error);
    this.outputRecorder?.close().catch(console.error);
    this.inputRecorder = null;
    this.outputRecorder = null;
  }
}
