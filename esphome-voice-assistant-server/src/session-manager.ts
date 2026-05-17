export interface ConversationItem {
  type: 'message' | 'function_call' | 'function_call_output';
  role?: 'user' | 'assistant';
  content?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface SessionCache {
  items: ConversationItem[];
  updatedAt: number;
}

export class SessionManager {
  private cache = new Map<string, SessionCache>();
  private timeoutMs: number;

  constructor(timeoutSeconds: number) {
    this.timeoutMs = timeoutSeconds * 1000;
  }

  getCachedItems(clientId: string): ConversationItem[] {
    if (this.timeoutMs === 0) return [];
    const entry = this.cache.get(clientId);
    if (!entry) return [];
    if (Date.now() - entry.updatedAt > this.timeoutMs) {
      this.cache.delete(clientId);
      return [];
    }
    return entry.items;
  }

  updateCache(clientId: string, items: ConversationItem[]): void {
    if (this.timeoutMs === 0 || items.length === 0) return;
    this.cache.set(clientId, { items, updatedAt: Date.now() });
  }

  clearCache(clientId: string): void {
    this.cache.delete(clientId);
  }
}
