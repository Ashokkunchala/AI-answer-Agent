// ai-client.js — streaming AI answer client (worker /v1/chat/completions).
//
// Replicates the app's worker-routed streaming request (model selection,
// system prompts and context injection are handled server-side) with the
// additions the voice pipeline needs: warmup ping, first-token timing and
// cancellation. Answers stream as SSE deltas.
'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');

function parseSSE(body, onDelta) {
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let model = null;
    (function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          if (buf.trim()) { try { consumeLine(buf.trim()); } catch (e) { reject(e); return; } }
          resolve({ text: full, model });
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try { consumeLine(line); } catch (e) { reject(e); return; }
          }
        }
        pump();
      }).catch(reject);
    })();

    function consumeLine(line) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      const j = JSON.parse(data);
      if (j.model) model = j.model;
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta, full);
      }
    }
  });
}

class AiClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workerUrl = (options.workerUrl || '').replace(/\/+$/, '');
    this.defaultWorkerUrl = options.defaultWorkerUrl || '';
    this.apiKey = options.apiKey || '';
    this.resume = options.resume || undefined;
    this.jobDesc = options.jobDesc || undefined;
    this.targetName = options.targetName || undefined;
    this.participants = options.participants?.length ? options.participants : undefined;
    this.maxTokens = options.maxTokens || 300;
    this.temperature = options.temperature ?? 0.1;
    this.model = options.model || 'auto';
    // Route answers through the worker's /api/answer endpoint when enabled
    // (carries sessionId/turnId/conversationContext); otherwise the default
    // /v1/chat/completions path is used.
    this.answerEndpoint = !!options.answerEndpoint;
    this.log = options.log || ((..._a) => { });
    this._ctrl = null;
    this.lastError = null;
    this.warm = false;
    // Model learning/cooldown: when the worker routes around this.model
    // (observed via the streamed chunk's model field) or it outright fails
    // with a credit/quota error, blacklist it for a while and send the last
    // known-good model explicitly instead. This avoids paying the wasted
    // routing attempt (~1-2s) on every answer once a model is degraded.
    this._modelCooldown = new Map();
    this._cooldownMs = options.modelCooldownMs ?? 10 * 60 * 1000; // 0 disables
    this._lastGoodModel = null;
    this._lastStreamModel = null;
    // Optional persistence: whisper-tier behavior wants the learned model to
    // survive restarts (skip the one wasted routing attempt on cold boot).
    this._modelCacheFile = options.modelCacheFile || null;
    this._modelCacheTtlMs = options.modelCacheTtlMs ?? 24 * 60 * 60 * 1000;
    this._revalidateMs = options.revalidateMs ?? 15 * 60 * 1000;
    this._learnedAt = 0;
    this._revalidateAt = 0;
    this._savedModel = null;
    this._savedAt = 0;
    if (this._modelCacheFile) {
      try {
        const raw = JSON.parse(fs.readFileSync(this._modelCacheFile, 'utf8'));
        if (raw && typeof raw.model === 'string' && raw.model !== 'auto' && raw.at && (Date.now() - raw.at) < this._modelCacheTtlMs) {
          this._lastGoodModel = raw.model;
          this._learnedAt = raw.at;
          this.log('[ai] restored learned model', raw.model, 'from cache');
        }
      } catch (_) { /* no cache yet */ }
    }
    this._revalidateAt = Date.now() + this._revalidateMs;
  }

  #candidates() {
    const list = [];
    if (this.workerUrl && this.workerUrl !== this.defaultWorkerUrl) list.push(this.workerUrl);
    list.push(this.defaultWorkerUrl);
    return list.filter(Boolean).map((u) => u.replace(/\/+$/, ''));
  }

  #onCooldown(model) {
    if (!this._cooldownMs || !model || model === 'auto') return false;
    const until = this._modelCooldown.get(model);
    if (!until) return false;
    if (until <= Date.now()) { this._modelCooldown.delete(model); return false; }
    return true;
  }

  #blacklist(model) {
    if (!this._cooldownMs || !model || model === 'auto') return;
    this._modelCooldown.set(model, Date.now() + this._cooldownMs);
    this.log('[ai] model on cooldown:', model, 'for', this._cooldownMs, 'ms');
  }

  // Pick the model to send: the caller's preferred one unless it is known to be
  // degraded (cooldown), in which case fall back to the last streaming model
  // the worker actually used, else let the worker auto-route. For 'auto' we
  // reuse the learned good model explicitly to skip router climbing, but drop
  // back to 'auto' periodically to re-validate and pick up recovered models.
  #effectiveModel(preferred) {
    const backup = (this._lastGoodModel && this._lastGoodModel !== preferred && !this.#onCooldown(this._lastGoodModel))
      ? this._lastGoodModel
      : 'auto';
    if (preferred !== 'auto') {
      if (this.#onCooldown(preferred)) return backup;
      return preferred;
    }
    const learned = this._lastGoodModel;
    if (learned && learned !== 'auto' && !this.#onCooldown(learned) && this._revalidateAt > Date.now()) {
      return learned;
    }
    return 'auto';
  }

  #saveCache() {
    if (!this._modelCacheFile || !this._lastGoodModel) return;
    if (this._savedModel === this._lastGoodModel && (Date.now() - this._savedAt) < 60 * 1000) return;
    try {
      fs.writeFileSync(this._modelCacheFile, JSON.stringify({ model: this._lastGoodModel, at: Date.now() }));
      this._savedModel = this._lastGoodModel;
      this._savedAt = Date.now();
    } catch (_) { /* best-effort */ }
  }

  #rememberStream(model, wasAuto = false) {
    if (!model) return;
    this._lastStreamModel = model;
    const changed = this._lastGoodModel !== model;
    if (changed) {
      this._lastGoodModel = model;
      this._learnedAt = Date.now();
      this.#saveCache();
    }
    // A changed pick or an auto-routed request (revalidation) both confirm the
    // current best model; steady-state explicit sends are left alone so the
    // worker is re-checked periodically (revalidateMs) to pick up recovered
    // models or credits.
    if (changed || wasAuto) this._revalidateAt = Date.now() + this._revalidateMs;
  }

  #maybeLearn(cooldownTarget) {
    // The streamed chunk exposes the model the worker actually used. When the
    // request is a specific model but the worker routed to something else, that
    // target couldn't be served (e.g. out of credits) — learn it on cooldown.
    if (cooldownTarget && cooldownTarget !== 'auto' && this._lastStreamModel && this._lastStreamModel !== cooldownTarget) {
      this.#blacklist(cooldownTarget);
    }
    // Credit/quota failures are definitive too — skip the doomed attempt next time.
    if (this.lastError && /insufficient|quota|credits?|ai gateway/i.test(String(this.lastError.message))) {
      this.#blacklist(cooldownTarget);
    }
    // A 5xx on an explicitly-requested model means that model can't be served
    // right now; fall back to auto (or the learned good model) which still
    // answers. Cooldown keeps us from hammering a dead model.
    if (cooldownTarget && cooldownTarget !== 'auto' && this.lastError && /Agent 5\d\d|status 5\d\d|500/.test(String(this.lastError.message))) {
      this.#blacklist(cooldownTarget);
    }
  }

  // Verify the backend is reachable without spending tokens.
  async warmup() {
    const urls = this.#candidates();
    for (const base of urls) {
      const t0 = process.hrtime.bigint();
      try {
        const r = await fetch(base + '/', { method: 'GET', signal: AbortSignal.timeout(3000) });
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        // Any HTTP answer (404/405/200…) proves the route is alive.
        this.warm = true;
        this.emit('warm', { base, ms: Math.round(ms), status: r.status });
        return { ok: true, base, ms: Math.round(ms), status: r.status };
      } catch (err) {
        this.log('[ai] warmup reachability failed:', base, err.message);
      }
    }
    this.warm = false;
    return { ok: false, error: 'unreachable' };
  }

  #stream(key, onDelta, effModel, signal) {
    // Try each candidate worker URL in order until one streams.
    const mk = (withKey) => {
      const headers = { 'Content-Type': 'application/json' };
      if (withKey && this.apiKey) headers['Authorization'] = 'Bearer ' + this.apiKey;
      return headers;
    };
    const chatPayload = () => ({
      model: effModel,
      messages: key.messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
      resume: this.resume,
      jobDesc: this.jobDesc,
      targetName: this.targetName,
      participants: this.participants,
      ...(key.taskType && key.taskType !== 'auto' ? { task_type: key.taskType } : {}),
    });
    const answerPayload = () => ({
      sessionId: key.sessionId,
      turnId: key.turnId,
      question: key.messages && key.messages.length ? String(key.messages[key.messages.length - 1].content) : String(key.transcript || ''),
      conversationContext: key.conversationContext,
      model: effModel,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    });

    return (async () => {
      // Prefer /api/answer (sessionId/turnId aware) but fall back to the
      // battle-tested /v1/chat/completions path on the same base if it fails,
      // so a misbehaving/redeploying answer endpoint can't kill voice answers.
      const endpoints = this.answerEndpoint
        ? [['/api/answer', answerPayload], ['/v1/chat/completions', chatPayload]]
        : [['/v1/chat/completions', chatPayload]];

      let lastError = null;
      for (const base of this.#candidates()) {
        for (const [endpoint, payloadFn] of endpoints) {
          if (signal && signal.aborted) throw dim('cancelled');
          const payload = payloadFn();
          let r;
          try {
            r = await fetch(base + endpoint, {
              method: 'POST',
              headers: mk(endpoint !== '/api/answer'),
              body: JSON.stringify(payload),
              signal,
            });
          } catch (err) {
            if (err.name === 'AbortError') throw dim('cancelled');
            lastError = err;
            continue;
          }
          if (endpoint !== '/api/answer' && r.status === 403 && this.apiKey) {
            this.log('[ai] 403 with key, retrying without', base);
            r = await fetch(base + endpoint, {
              method: 'POST',
              headers: mk(false),
              body: JSON.stringify(payload),
              signal,
            });
            if (r.ok) this.emit('key-cleared');
          }
          if (!r.ok) {
            const text = await r.text().catch(() => r.statusText);
            lastError = new Error(`Agent ${r.status}: ${text.substring(0, 200)}`);
            this.log('[ai] worker rejected', base + endpoint, r.status);
            continue;
          }
          const { text, model } = await parseSSE(r.body, onDelta);
          if (!text || !text.trim()) {
            lastError = new Error('Empty response from agent');
            continue;
          }
          this._lastStreamModel = model || null;
          return { content: text, model };
        }
      }
      throw lastError || new Error('All worker endpoints failed');
    })();
  }

  // streamAnswer({ transcript, taskType, history, conversationContext, turnId, sessionId, model })
  // → streaming response via events ('started' | 'first-token' | 'first-useful' | 'token' | 'done').
  async streamAnswer({ transcript, taskType, history, conversationContext, turnId, sessionId, model }) {
    const messages = [];
    if (conversationContext) messages.push({ role: 'system', content: String(conversationContext) });
    if (Array.isArray(history) && history.length) {
      for (const turn of history.slice(0, 12)) {
        if (turn && turn.role && turn.content) messages.push({ role: turn.role, content: String(turn.content) });
      }
    }
    messages.push({ role: 'user', content: String(transcript) });

    const effModel = this.#effectiveModel((model && model !== 'auto') ? model : this.model);
    const requestCtrl = new AbortController();
    // Keep the active controller reference tied to this exact request. A fast
    // speculative answer may be cancelled and replaced by a corrected final;
    // an older request must never clear or abort the newer request's controller.
    this._ctrl = requestCtrl;
    const t0 = process.hrtime.bigint();
    let firstTokenAt = null;
    let firstUsefulAt = null;
    let emittedFirst = false;
    let text = '';

    this.emit('started', { transcript, turnId, sessionId });

    const onDelta = (delta, full) => {
      if (!emittedFirst && delta) {
        emittedFirst = true;
        firstTokenAt = process.hrtime.bigint();
        this.emit('first-token', {
          ms: Math.round(Number(firstTokenAt - t0) / 1e6),
          text: delta,
        });
      }
      // A "useful" token is the first word ≥ 2 chars — skips filler.
      if (!firstUsefulAt && delta && delta.trim().length >= 2) {
        firstUsefulAt = process.hrtime.bigint();
        this.emit('first-useful', {
          ms: Math.round(Number(firstUsefulAt - t0) / 1e6),
        });
      }
      text = full;
      this.emit('token', { text: full, delta });
    };

    try {
      const result = await this.#stream(
        { messages, taskType, transcript, turnId, sessionId, conversationContext },
        onDelta,
        effModel,
        requestCtrl.signal
      );
      const content = result?.content || '';
      this.#rememberStream(result?.model || null, effModel === 'auto');
      this.#maybeLearn(effModel);
      if (!emittedFirst) {
        const seed = (text || content || '').slice(0, 40);
        this.emit('first-token', { ms: 0, text: '' });
        this.emit('first-useful', { ms: 0 });
      }
      const doneMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      this.emit('done', {
        text: content || text,
        ms: doneMs,
        firstTokenMs: firstTokenAt ? Math.round(Number(firstTokenAt - t0) / 1e6) : null,
        firstUsefulMs: firstUsefulAt ? Math.round(Number(firstUsefulAt - t0) / 1e6) : null,
      });
      return content || text;
    } catch (err) {
      if (err && err.code === 'cancelled') {
        this.emit('cancelled', { text });
        return null;
      }
      this.lastError = err;
      this.#maybeLearn((model && model !== 'auto') ? model : this.model);
      this.emit('error', { message: String((err && err.message) || err), text });
      throw err;
    } finally {
      if (this._ctrl === requestCtrl) this._ctrl = null;
    }
  }

  cancel() {
    if (this._ctrl) this._ctrl.abort();
  }
}

function dim(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

module.exports = { AiClient, parseSSE };