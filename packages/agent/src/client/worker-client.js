import fetch from 'node-fetch';

function environmentKey() {
  return process.env.WORKER_API_KEY || process.env.CLOUDFLARE_WORKER_API_KEY;
}

// The standalone terminal uses the user's Cloudflare Worker as its model backend.
export class ProviderClient {
  constructor(opts = {}) {
    this.workerUrl = (opts.workerUrl || '').replace(/\/$/, '');
    this.geminiUrl = (opts.geminiUrl || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
    this.provider = opts.provider || 'worker';
    this.configApiKey = opts.apiKey || '';
    this.model = opts.model || 'auto';
    this.systemPrompt = opts.systemPrompt;
  }

  setConfig(cfg) {
    if (cfg.provider) this.provider = cfg.provider;
    if (cfg.workerUrl) this.workerUrl = String(cfg.workerUrl).replace(/\/$/, '');
    if (cfg.geminiUrl) this.geminiUrl = String(cfg.geminiUrl).replace(/\/$/, '');
    if (cfg.apiKey !== undefined) this.configApiKey = cfg.apiKey || '';
    if (cfg.model) this.model = cfg.model;
    if (cfg.systemPrompt) this.systemPrompt = cfg.systemPrompt;
  }

  get configured() {
    return Boolean(this.endpointBaseUrl());
  }

  get apiKey() {
    if (this.provider === 'gemini') return this.configApiKey || process.env.GEMINI_API_KEY || '';
    return this.configApiKey || environmentKey();
  }

  // Real-time connectivity check to the worker
  async checkConnectivity() {
    if (!this.configured) return { ok: false, error: `${this.provider} API base URL not configured` };
    try {
      const res = await fetch(this.endpoint('/health'), {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(500)
      });
      const data = await res.text().catch(() => null);
      return {
        ok: res.ok,
        status: res.status,
        data,
        provider: this.provider,
        url: this.endpoint('/health')
      };
    } catch (e) {
      return { ok: false, error: e.message, provider: this.provider, url: this.endpoint('/health') };
    }
  }

  endpointBaseUrl() {
    return this.provider === 'gemini' ? this.geminiUrl : this.workerUrl;
  }

  endpoint(path) {
    if (this.provider === 'gemini') {
      const route = path === '/v1/chat/completions' ? '/chat/completions'
        : path === '/v1/models' || path === '/health' ? '/models'
        : path;
      return `${this.baseUrl()}${route.startsWith('/') ? route : `/${route}`}`;
    }
    return `${this.baseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  }

  buildHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  baseUrl() {
    const url = this.endpointBaseUrl();
    if (url) return url;
    if (this.provider === 'gemini') throw new Error('Gemini API URL not configured.');
    throw new Error('Worker URL not configured. Use `agent setup --worker <url>`.');
  }

  // POST /v1/chat/completions with one safety net: if the worker rejects the
  // requested model as unknown (a stale/placeholder model name), retry the same
  // request with `auto` so the router can pick a working free-tier model rather
  // than failing the whole turn.
  async postCompletion(body, signal) {
    const send = (payload) =>
      fetch(this.endpoint('/v1/chat/completions'), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal,
      });

    let res = await send(body);
    let text = null;
    if (!res.ok) {
      text = await res.text().catch(() => '');
      if (this.provider === 'worker' && res.status === 400 && /unknown model/i.test(text) && body.model && body.model !== 'auto') {
        this.model = body.model = 'auto';
        res = await send(body);
        text = null;
      }
    }
    if (!res.ok) {
      if (text === null) text = await res.text().catch(() => '');
      const providerName = this.provider === 'gemini' ? 'Gemini' : 'Worker';
      throw new Error(`${providerName} API error ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  buildBody(payload = {}) {
    const requestedModel = payload.model || this.model;
    const selectedModel = this.provider === 'gemini'
      ? (!requestedModel || requestedModel === 'auto' ? 'gemini-3.8-flash' : requestedModel)
      : requestedModel || 'auto';
    const body = {
      model: selectedModel,
      messages: payload.messages || [],
      stream: Boolean(payload.stream),
      temperature: payload.temperature ?? 0.2,
      // `raw: true` tells the worker not to inject its own DevOps system
      // prompt — the CLI supplies its own agent system prompt.
      raw: payload.raw !== false,
    };
    if (payload.max_tokens) body.max_tokens = payload.max_tokens;
    if (this.provider === 'worker' && payload.task_type) body.task_type = payload.task_type;
    if (Array.isArray(payload.tools) && payload.tools.length) {
      body.tools = payload.tools;
      if (payload.tool_choice) body.tool_choice = payload.tool_choice;
    }
    if (this.provider === 'worker') {
      if (payload.sessionId) body.sessionId = payload.sessionId;
      if (payload.turnId) body.turnId = payload.turnId;
      if (payload.tool_stream) body.tool_stream = true;
    } else {
      delete body.raw;
    }
    return body;
  }

  // Non-streaming chat completion -> parsed JSON chat.completion object.
  async chat(payload = {}) {
    const res = await this.postCompletion(this.buildBody({ ...payload, stream: false }), payload.signal);
    return res.json();
  }

  // Streaming chat completion -> async generator of parsed chunk objects.
  //
  // Tolerant of workers that answer a streaming request with a buffered
  // JSON completion (e.g. workers without tool-call streaming): in that case
  // a single synthetic chunk is yielded. SSE `marker` events are yielded
  // as-is so callers can display latency.
  async *streamChat(payload = {}) {
    const res = await this.postCompletion(this.buildBody({ ...payload, stream: true }), payload.signal);

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      const message = data?.choices?.[0]?.message || {};
      yield {
        id: data?.id,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: message.content || '', tool_calls: message.tool_calls }, finish_reason: data?.choices?.[0]?.finish_reason || 'stop' }],
        usage: data?.usage,
      };
      return;
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
        } catch (e) {
          // Ignore malformed keep-alive lines.
          console.debug?.(`Malformed SSE data: ${e.message}`);
        }
      }
    }
  }

  async createSession(payload) {
    if (this.provider !== 'worker') return null;
    const res = await fetch(`${this.baseUrl()}/api/session`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload || {}),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async getContext(sessionId, limit = 50) {
    if (this.provider !== 'worker') return null;
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/context?limit=${limit}`, {
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async finalize(sessionId) {
    if (this.provider !== 'worker') return null;
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/finalize`, {
      method: 'POST',
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async report(sessionId) {
    if (this.provider !== 'worker') return null;
    const res = await fetch(`${this.baseUrl()}/api/session/${encodeURIComponent(sessionId)}/report`, {
      headers: this.buildHeaders(),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  }

  async health() {
    if (!this.configured) return { ok: false, error: `${this.provider} API base URL not configured` };
    try {
      const res = await fetch(this.endpoint('/health'), { headers: this.buildHeaders() });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data, provider: this.provider };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async models() {
    if (!this.configured) return [];
    try {
      const res = await fetch(this.endpoint('/v1/models'), { headers: this.buildHeaders() });
      if (!res.ok) return [];
      const data = await res.json();
      return data.data || [];
    } catch (e) {
      console.debug?.(`Failed to fetch models: ${e.message}`);
      return [];
    }
  }

  // Public live worker status: usage, cost, routing policy, free pool, setup.
  async status() {
    if (this.provider !== 'worker' || !this.workerUrl) return null;
    try {
      const res = await fetch(`${this.workerUrl}/v1/status`);
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.debug?.(`Failed to fetch status: ${e.message}`);
      return null;
    }
  }

  // Authenticated endpoints below (require apiKey).

  async usage() {
    if (this.provider !== 'worker' || !this.workerUrl || !this.apiKey) return null;
    try {
      const res = await fetch(`${this.workerUrl}/v1/usage`, { headers: this.buildHeaders() });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.debug?.(`Failed to fetch usage: ${e.message}`);
      return null;
    }
  }

  // Preview which task type + model chain a prompt routes to (auth required).
  async route(message, taskType) {
    if (this.provider !== 'worker' || !this.workerUrl || !this.apiKey) return null;
    try {
      const res = await fetch(`${this.workerUrl}/v1/route`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ message, question: message, task_type: taskType || undefined }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.debug?.(`Failed to fetch route preview: ${e.message}`);
      return null;
    }
  }

  async listKeys() {
    if (this.provider !== 'worker' || !this.workerUrl || !this.apiKey) return null;
    try {
      const res = await fetch(`${this.workerUrl}/v1/keys`, { headers: this.buildHeaders() });
      if (!res.ok) return null;
      const data = await res.json();
      return data.keys || [];
    } catch (e) {
      console.debug?.(`Failed to list keys: ${e.message}`);
      return null;
    }
  }

  async createKey(options = {}) {
    if (this.provider !== 'worker') throw new Error('API-key management is available only when using the Cloudflare Worker provider.');
    const res = await fetch(`${this.baseUrl()}/v1/keys`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(options),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Worker error ${res.status}`);
    return data;
  }

  async revokeKey(id) {
    if (this.provider !== 'worker') throw new Error('API-key management is available only when using the Cloudflare Worker provider.');
    const res = await fetch(`${this.baseUrl()}/v1/keys/revoke`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Worker error ${res.status}`);
    return data;
  }
}

// Compatibility export for projects that imported the original Worker client.
export const WorkerClient = ProviderClient;
