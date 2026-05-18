import WebSocket from 'ws';
import { Config } from './config.js';
import { ConversationItem } from './session-manager.js';
import { OpenAITool } from './mcp-client.js';
import { WavRecorder } from './audio-recorder.js';

export type AudioOutputCallback = (audio: Buffer) => void;
export type DisconnectCallback = () => void;
export type ToolCallHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

const ENABLE_DUPLEX = false; // whether to allow assistant to listen while speaking (may cause assistant to re-listen to its own voice and get confused)

const DISCONNECT_TOOL: OpenAITool = {
  type: 'function',
  name: 'disconnect_client',
  description: 'Disconnect the client when the conversation is complete or the user requests to stop. Do not stay silent doing nothing for too long.',
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
  private ws: WebSocket | null = null;
  private config: Config;
  private tools: OpenAITool[];
  private onAudio: AudioOutputCallback;
  private onDisconnect: DisconnectCallback;
  private onToolCall: ToolCallHandler;

  private conversationItems: ConversationItem[];
  private liveContext: string | null;
  private mcpPrompt: string | null;
  private sessionReady = false;
  // call_id → function name, populated from response.output_item.added
  private pendingCallNames = new Map<string, string>();

  private inputRecorder: WavRecorder | null = null;
  private outputRecorder: WavRecorder | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDisconnect = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private drainAudioBytes = 0;
  private isSpeaking = false;
  private responseAudioBytes = 0;

  constructor(
    config: Config,
    tools: OpenAITool[],
    cachedItems: ConversationItem[],
    recordingPath: string | null,
    liveContext: string | null,
    mcpPrompt: string | null,
    onAudio: AudioOutputCallback,
    onDisconnect: DisconnectCallback,
    onToolCall: ToolCallHandler,
  ) {
    this.config = config;
    this.tools = tools;
    this.conversationItems = [...cachedItems];
    this.liveContext = liveContext;
    this.mcpPrompt = mcpPrompt;
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
        console.error('[OpenAI] Socket error:', err.message);
      });
    });
  }

  private configureSession(): void {
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: this.config.instructions + '\nWhen you have finished what the user asked, call disconnect_client to end the conversation.',
        audio: {
          input: {
            transcription: { model: 'whisper-1' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'low',
            },
          },
          output: {
            voice: this.config.voice,
          },
        },
        tools: [DISCONNECT_TOOL, ...this.tools],
        tool_choice: 'auto',
      },
    });
  }

  private debug(msg: string): void {
    if (process.env.DEBUG === 'true') console.log(`[DEBUG] ${msg}`);
  }

  private handleEvent(event: Record<string, unknown>, onReady: () => void): void {
    const type = event.type as string;
    this.debug(`event: ${type}`);

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        if (!this.sessionReady) {
          this.sessionReady = true;
          this.restoreContext();
          this.debug('session ready → resetIdleTimer');
          this.resetIdleTimer();
          onReady();
        }
        break;
      }

      case 'input_audio_buffer.speech_started': {
        this.debug(`speech_started → clear idleTimer=${!!this.idleTimer} playbackTimer=${!!this.playbackTimer}`);
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
        if (this.playbackTimer) { clearTimeout(this.playbackTimer); this.playbackTimer = null; }
        break;
      }

      case 'response.output_audio.delta': {
        const audio = Buffer.from(event.delta as string, 'base64');
        this.outputRecorder?.write(audio);
        this.onAudio(this.applyGain(audio));
        this.isSpeaking = true;
        this.responseAudioBytes += audio.length;
        if (this.idleTimer) {
          this.debug('audio.delta → clear idleTimer');
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
        if (this.pendingDisconnect) this.drainAudioBytes += audio.length;
        break;
      }

      case 'response.output_audio.done': {
        // 24kHz mono 16-bit = 48000 bytes/sec
        const playbackMs = (this.responseAudioBytes / 48000) * 1000;
        this.responseAudioBytes = 0;
        this.debug(`audio.done → playbackMs=${Math.round(playbackMs)}`);
        if (this.pendingDisconnect) this.scheduleDrain();
        if (playbackMs > 0) {
          if (this.playbackTimer) clearTimeout(this.playbackTimer);
          this.playbackTimer = setTimeout(() => {
            this.playbackTimer = null;
            this.isSpeaking = false;
            this.debug('playbackTimer fired → resetIdleTimer');
            this.resetIdleTimer();
          }, Math.round(playbackMs) + 200);
          this.debug(`audio.done → playbackTimer set for ${Math.round(playbackMs) + 200}ms`);
        } else {
          this.isSpeaking = false;
          this.debug('audio.done → playbackMs=0, skip idle timer');
        }
        break;
      }

      case 'response.output_audio_transcript.done': {
        const transcript = event.transcript as string | undefined;
        if (transcript) {
          console.log(`[OpenAI] Assistant: ${transcript}`);
          this.conversationItems.push({ type: 'message', role: 'assistant', content: transcript });
        }
        break;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = event.transcript as string | undefined;
        if (transcript) {
          console.log(`[OpenAI] User: ${transcript}`);
          this.conversationItems.push({ type: 'message', role: 'user', content: transcript });
        }
        break;
      }

      case 'conversation.item.added': {
        // audio items arrive before transcription is ready; handled by input_audio_transcription.completed
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.role === 'user' && Array.isArray(item.content)) {
          for (const part of item.content as Array<Record<string, unknown>>) {
            const text = part.text as string | undefined;
            if (text) {
              console.log(`[OpenAI] User: ${text}`);
              this.conversationItems.push({ type: 'message', role: 'user', content: text });
              break;
            }
          }
        }
        break;
      }

      // Capture function name before arguments start streaming
      case 'response.output_item.added': {
        const item = (event.item ?? {}) as Record<string, unknown>;
        if (item.type === 'function_call' && item.call_id && item.name) {
          this.pendingCallNames.set(item.call_id as string, item.name as string);
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        const callId = event.call_id as string;
        const name = this.pendingCallNames.get(callId) ?? '';
        this.pendingCallNames.delete(callId);
        void this.executeTool(callId, name, event.arguments as string);
        break;
      }

      case 'error': {
        const err = event.error as Record<string, unknown>;
        console.error('[OpenAI] Error event:', err?.message ?? JSON.stringify(event.error));
        break;
      }
    }
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
      this.send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: 'Disconnected.' },
      });
      this.pendingDisconnect = true;
      this.drainAudioBytes = 0;
      this.scheduleDrain();
      return;
    }

    let output: string;
    try {
      output = await this.onToolCall(name, args);
    } catch (err: unknown) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
    console.log(`[OpenAI] Tool response: ${output}`);

    this.conversationItems.push({ type: 'function_call', name, call_id: callId, arguments: argsJson });
    this.conversationItems.push({ type: 'function_call_output', call_id: callId, output });

    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    this.send({ type: 'response.create' });
  }

  private restoreContext(): void {
    if (this.mcpPrompt) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: this.mcpPrompt }],
        },
      });
      console.log('[OpenAI] Injected HA Assist prompt');
    }

    if (this.liveContext) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: `Current home state:\n${this.liveContext}` }],
        },
      });
      console.log('[OpenAI] Injected live home context');
    }

    if (this.conversationItems.length === 0) return;

    for (const item of this.conversationItems) {
      if (item.type !== 'message') continue;
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: item.role,
          content: [
            item.role === 'user'
              ? { type: 'input_text', text: item.content ?? '' }
              : { type: 'output_text', text: item.content ?? '' },
          ],
        },
      });
    }
    console.log(`[OpenAI] Restored ${this.conversationItems.length} context items`);
  }

  sendAudio(pcm: Buffer): void {
    if (!this.sessionReady || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!ENABLE_DUPLEX && this.isSpeaking) return;
    this.inputRecorder?.write(pcm);
    this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.debug(`resetIdleTimer → ${this.config.idle_timeout_seconds}s`);
    this.idleTimer = setTimeout(() => {
      console.log('[OpenAI] Idle timeout — closing session');
      this.onDisconnect();
    }, this.config.idle_timeout_seconds * 1000);
  }

  private scheduleDrain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    // 24kHz mono 16-bit = 48000 bytes/sec; add 500ms buffer for network + ESP32 ring buffer
    const playbackMs = (this.drainAudioBytes / 48000) * 1000;
    const delayMs = Math.round(playbackMs) + 500;
    console.log(`[OpenAI] Scheduling disconnect in ${delayMs}ms (${Math.round(playbackMs)}ms audio + 500ms buffer)`);
    this.drainTimer = setTimeout(() => {
      console.log('[OpenAI] Audio drained — disconnecting');
      this.onDisconnect();
    }, delayMs);
  }

  private applyGain(pcm: Buffer): Buffer {
    const gain = this.config.output_gain;
    if (gain === 1.0) return pcm;
    const out = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i < pcm.length - 1; i += 2) {
      const sample = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain)));
      out.writeInt16LE(sample, i);
    }
    return out;
  }

  interrupt(): void {
    this.isSpeaking = false;
    this.send({ type: 'response.cancel' });
    this.send({ type: 'input_audio_buffer.clear' });
  }

  getConversationItems(): ConversationItem[] {
    return [...this.conversationItems];
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    if (this.drainTimer) clearTimeout(this.drainTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.close();
    this.ws = null;
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
