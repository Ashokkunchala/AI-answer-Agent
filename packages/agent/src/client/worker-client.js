import fetch from 'node-fetch';

// Thin OpenAI-compatible client for the DevOps AI Agent worker.
// The agent speaks the OpenAI chat protocol; the worker adapts requests to
// Cloudflare Workers AI (and optional AI Gateway fallback).
export class WorkerClient {
  constructor(opts = {}) {
    this.workerUrl = (opts.workerUrl || '').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt;
  }

  setConfig(cfg) {
    if (cfg.workerUrl) this.workerUrl = String(cfg.workerUrl).replace(/\/$/, '');
    if (cfg.apiKey) this.apiKey = cfg.apiKey;
    if (cfg.model) this.model = cfg.model;
    if (cfg.systemPrompt) this.systemPrompt = cfg.systemPrompt;
  }

  get configured() {
    return Boolean(this.workerUrl);
  }

  buildHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  baseUrl() {
    if (!this.workerUrl) {
      throw new Error('workerUrl not configured. Set it with: agent config --set workerUrl=http://127.0.0.1:8787 --save');
    }
    return this.workerUrl;
  }

  buildBody(payload = {}) {
    const body = {
      model: payload.model || this.model || 'auto',
      messages: payload.messages || [],
      stream: Boolean(payload.stream),
      temperature: payload.temperature ?? 0.2,
      // `raw: true` tells the worker not to inject its own DevOps system
      // prompt — the CLI supplies its own agent system prompt.
      raw: payload.raw !== false,
    };
    if (payload.max_tokens) body.max_tokens = payload.max_tokens;
    if (payload.task_type) body.task_type = payload.task_type;
    if (Array.isArray(payload.tools) && payload.tools.length) {
      body.tools = payload.tools;
      if (payload.tool_choice) body.tool_choice = payload.tool_choice;
    }
    if (payload.sessionId) body.sessionId = payload.sessionId;
    if (payload.turnId) body.turnId = payload.turnId;
    return body;
  }

  // Non-streaming chat completion -> parsed JSON chat.completion object.
  async chat(payload = {}) {
    const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody({ ...payload, stream: false })),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Worker error ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }

  // Streaming chat completion -> async generator of parsed chunk objects.
  // Each yielded item is an OpenAI `chat.completion.chunk`.
  async *streamChat(payload = {}) {
    const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(this.buildBody({ ...payload, stream: true })),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Worker error ${res.status}: ${text.slice(0, 500)}`);
    }
    if (!res.body) throw new Error('Worker returned no stream body');

    let buffer = '';
    for await (const chunk of res.body) {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore malformed keep-alive lines.
        }
      }
    }
  }

  async createSession(payload) {
    const res = await fetch(`${this.baseUrl()}/api/session`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async getContext(sessionId, limit = 50) {
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/context?limit=${limit}`, {
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async finalize(sessionId) {
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/finalize`, {
      method: 'POST',
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async report(sessionId) {
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/report`, {
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async health() {
    if (!this.workerUrl) return { ok: false, error: 'workerUrl not configured' };
    try {
      const res = await fetch(`${this.workerUrl}/health`);
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async models() {
    if (!this.workerUrl) return [];
    try {
      const res = await fetch(`${this.workerUrl}/v1/models`, { headers: this.buildHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      return data.data || [];
    } catch {
      return [];
    }
  }
}
