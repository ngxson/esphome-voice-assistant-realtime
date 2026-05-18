export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface OpenAITool {
  type: 'function';
  name: string;
  description: string;
  parameters: MCPTool['inputSchema'];
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { message: string };
}

export class MCPClient {
  private url: string;
  private token: string;
  private requestId = 0;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });

    if (!response.ok) {
      throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('text/event-stream')) {
      // Handle SSE response — extract the matching JSON-RPC result
      const text = await response.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        const data = JSON.parse(payload) as JsonRpcResponse;
        if (data.id === id) {
          if (data.error) throw new Error(data.error.message);
          return data.result;
        }
      }
      throw new Error('No matching response found in SSE stream');
    }

    const data = await response.json() as JsonRpcResponse;
    if (data.error) throw new Error(data.error.message);
    return data.result;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request('tools/list', {}) as { tools?: MCPTool[] };
    return result.tools ?? [];
  }

  async getLiveContext(): Promise<string> {
    return this.callTool('GetLiveContext', {});
  }

  async getPrompt(name: string): Promise<string | null> {
    const result = await this.request('prompts/get', { name }) as {
      messages?: Array<{ role: string; content: { type: string; text?: string } }>;
    };
    if (!result.messages) return null;
    return result.messages
      .filter((m) => m.content?.type === 'text' && m.content.text)
      .map((m) => m.content.text as string)
      .join('\n');
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (result.content) {
      return result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text as string)
        .join('\n');
    }
    return JSON.stringify(result);
  }
}

export function mcpToolToOpenAI(tool: MCPTool): OpenAITool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}
