import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import path from 'path';
import { Config } from './config.js';
import { SessionManager } from './session-manager.js';
import { MCPClient, OpenAITool, mcpToolToOpenAI } from './mcp-client.js';
import { OpenAIRealtimeClient } from './openai-client.js';

export class VoiceAssistantServer {
  private config: Config;
  private sessionManager: SessionManager;
  private mcpTools: OpenAITool[] = [];
  private mcpClient: MCPClient | null = null;
  private mcpPrompt: string | null = null;

  constructor(config: Config) {
    this.config = config;
    this.sessionManager = new SessionManager(config.session_reuse_timeout_seconds);
  }

  async init(): Promise<void> {
    if (this.config.enable_ha_tools && this.config.ha_mcp_url) {
      this.mcpClient = new MCPClient(this.config.ha_mcp_url, this.config.longlived_token);
      await this.refreshMCPData(true);
      setInterval(() => void this.refreshMCPData(false), 5 * 60 * 1000);
    }
  }

  private async refreshMCPData(log: boolean): Promise<void> {
    if (!this.mcpClient) return;
    try {
      const tools = await this.mcpClient.listTools();
      this.mcpTools = tools.map(mcpToolToOpenAI);
      if (log) console.log(`[Server] Loaded ${this.mcpTools.length} HA tools from MCP`);
    } catch (err: unknown) {
      console.error('[Server] Failed to refresh MCP tools:', err instanceof Error ? err.message : err);
    }
    try {
      this.mcpPrompt = await this.mcpClient.getPrompt('Assist');
      if (log && this.mcpPrompt) console.log('[Server] Loaded HA Assist prompt from MCP');
    } catch (err: unknown) {
      console.error('[Server] Failed to refresh MCP prompt:', err instanceof Error ? err.message : err);
    }
  }

  start(): void {
    const wss = new WebSocketServer({
      port: this.config.websocket_port,
      // Accept connections from any origin (browser, file://, ESP32 native client)
      verifyClient: ({ origin }: { origin: string }) => {
        console.log(`[Server] Connection from origin: ${origin ?? '(none)'}`);
        return true;
      },
    });
    console.log(`[Server] Listening on port ${this.config.websocket_port}`);

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const clientId = req.socket.remoteAddress ?? 'unknown';
      console.log(`[Server] Client connected: ${clientId}`);
      this.handleClient(ws, clientId);
    });

    wss.on('error', (err) => {
      console.error('[Server] WebSocket server error:', err.message);
    });
  }

  private async handleClient(ws: WebSocket, clientId: string): Promise<void> {
    const cachedItems = this.sessionManager.getCachedItems(clientId);
    if (cachedItems.length > 0) {
      console.log(`[Server] Restoring ${cachedItems.length} context items for ${clientId}`);
    }

    const recordingPath = this.config.enable_recording
      ? path.join('/data/recordings', `${clientId.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}`)
      : null;

    let openaiClient: OpenAIRealtimeClient | null = null;
    let cleaned = false;

    let liveContext: string | null = null;
    if (this.mcpClient) {
      try {
        liveContext = await this.mcpClient.getLiveContext();
        console.log(`[Server] Fetched live context for ${clientId}`);
      } catch (err: unknown) {
        console.error('[Server] Failed to fetch live context:', err instanceof Error ? err.message : err);
      }
    }

    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;

      if (openaiClient) {
        const items = openaiClient.getConversationItems();
        this.sessionManager.updateCache(clientId, items);
        openaiClient.close();
        openaiClient = null;
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };

    openaiClient = new OpenAIRealtimeClient(
      this.config,
      this.mcpTools,
      cachedItems,
      recordingPath,
      liveContext,
      this.mcpPrompt,
      (audio) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(audio);
        }
      },
      () => {
        console.log(`[Server] Session ended for ${clientId}`);
        cleanup();
      },
      async (name, args) => {
        if (!this.mcpClient) throw new Error('HA MCP is not configured');
        return this.mcpClient.callTool(name, args);
      },
    );

    openaiClient.connect()
      .then(() => console.log(`[Server] OpenAI session ready for ${clientId}`))
      .catch((err: unknown) => {
        console.error(`[Server] OpenAI connection failed for ${clientId}:`, err instanceof Error ? err.message : err);
        cleanup();
      });

    ws.on('message', (data, isBinary) => {
      if (!openaiClient) return;

      if (isBinary) {
        openaiClient.sendAudio(data as Buffer);
      } else {
        try {
          const msg = JSON.parse((data as Buffer).toString()) as { type?: string };
          if (msg.type === 'interrupt') {
            console.log(`[Server] Interrupt received from ${clientId}`);
            openaiClient.interrupt();
          }
        } catch {
          // ignore unparseable text frames
        }
      }
    });

    ws.on('close', () => {
      console.log(`[Server] Client disconnected: ${clientId}`);
      cleanup();
    });

    ws.on('error', (err) => {
      console.error(`[Server] Client error (${clientId}):`, err.message);
      cleanup();
    });
  }
}
