// streaming-stt.js — persistent Deepgram Flux realtime transcription.
//
// Uses the Flux "turn-based" API:
//   wss://api.deepgram.com/v2/listen?model=flux-general-en&...
//
// Flux keeps ONE WebSocket open for the whole session and handles its own
// end-of-turn detection (model-integrated). It emits TurnInfo events:
//   StartOfTurn -> Update* -> EagerEndOfTurn -> (TurnResumed)* -> EndOfTurn
// Every TurnInfo carries the WHOLE turn transcript so far, so there is no
// partial→final word stitching needed — the transcript manager replaces the
// turn text as new events land.
//
// Audio is streamed in ~80ms chunks (Flux's recommended granularity) and
// NEVER persisted to disk by this module.
'use strict';

const WebSocket = require('ws');
const { EventEmitter } = require('events');

// Technical vocabulary pushed into Flux keyterms so infra / resume jargon is
// recognised (see vocabulary.js for the full list). Flux keyterms are
// replaced wholesale on Configure, so keep one stable list per connection.
const KEYWORDS = [
  'kubernetes', 'terraform', 'docker', 'aws', 'azure', 'gcp',
  'iam', 'ec2', 's3', 'eks', 'ecs', 'lambda', 'cloudformation', 'ansible',
  'jenkins', 'gitlab', 'helm', 'prometheus', 'grafana', 'terraform state',
  'vpc', 'subnet', 'load balancer', 'microservices', 'cicd',
  'observability', 'container', 'serverless', 'devops', 'sre',
  'mysql', 'postgres', 'mongodb', 'kafka', 'redis', 'chef', 'puppet',
];

// Parse one Flux WebSocket message into a normalized shape. Exported so the
// message contract is unit-testable without a live socket.
// Returns null for messages that carry no transcript/turn signal.
function parseFluxMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (_) {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  if (msg.type === 'TurnInfo' && msg.event) {
    const base = {
      kind: null,
      turnIndex: Number.isInteger(msg.turn_index) ? msg.turn_index : null,
      sequenceId: Number.isInteger(msg.sequence_id) ? msg.sequence_id : null,
      transcript: msg.transcript || '',
      endOfTurnConfidence: typeof msg.end_of_turn_confidence === 'number' ? msg.end_of_turn_confidence : null,
      trigger: msg.trigger || null,
      audioWindowStart: typeof msg.audio_window_start === 'number' ? msg.audio_window_start : null,
      audioWindowEnd: typeof msg.audio_window_end === 'number' ? msg.audio_window_end : null,
      words: Array.isArray(msg.words) ? msg.words : null,
    };
    switch (msg.event) {
      case 'StartOfTurn': return { ...base, kind: 'start' };
      case 'Update': return { ...base, kind: 'update' };
      case 'EagerEndOfTurn': return { ...base, kind: 'eager-end' };
      case 'TurnResumed': return { ...base, kind: 'turn-resumed' };
      case 'EndOfTurn': return { ...base, kind: 'final' };
      default: return { ...base, kind: 'unknown', rawEvent: msg.event };
    }
  }

  if (msg.type === 'Connected') return { kind: 'connected' };
  if (msg.type === 'ConfigureSuccess') return { kind: 'configure-success' };
  if (msg.type === 'Metadata') return null;
  if (msg.type === 'Error') {
    return { kind: 'error', message: msg.description || msg.message || 'Deepgram error' };
  }
  return null;
}

class StreamingSTT extends EventEmitter {
  constructor(options = {}) {
    super();
    this.apiKey = options.apiKey || '';
    this.host = options.host || 'api.deepgram.com';
    // Flux models: flux-general-en (English) or flux-general-multi.
    this.model = options.model || options.sttModel || 'flux-general-en';
    this.sampleRate = options.sampleRate || 16000;
    this._Ws = options.ws || WebSocket;
    this.languageHints = Array.isArray(options.languageHints) ? options.languageHints : [];
    this.keyterms = options.keywords || KEYWORDS;
    this.log = options.log || ((..._a) => { });

    // End-of-turn tuning (Flux). Higher eot_threshold = fewer false turn ends
    // but slower; eager_eot_threshold enables eager reply preparation.
    // Empirically (live sweep): eot_threshold 0.5 + eot_timeout_ms 1500-2000
    // lands EndOfTurn within ~100-160ms of speech end, keeping answers under
    // the 2s budget. Tightening below that (0.4/1000) can drop transcription.
    this.eotThreshold = options.eotThreshold ?? 0.5;
    this.eagerEotThreshold = options.eagerEotThreshold ?? 0.5; // null disables eager
    this.eotTimeoutMs = options.eotTimeoutMs ?? 1500;
    this.keepaliveMs = options.keepaliveMs ?? 15000;

    this._ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnect = options.maxReconnect ?? 6;
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._lastSentAt = Date.now();
    this._started = false;
    this._configured = false;
    this.lastError = null;
    this.bytesSent = 0;
    this._sendQueue = [];          // 20ms frame Buffers awaiting a chunk
    this._sendQueueBytes = 0;
    this.chunkBytes = Math.round((this.sampleRate * (options.chunkMs ?? 80)) / 1000) * 2;
    // Pre-connect audio buffer: frames arriving while the socket is still
    // opening (or reconnecting) are held here and flushed on `open`. Without
    // this the first ~1s of an interviewer's question is silently dropped,
    // turning "What is the difference between…" into a garbled fragment the
    // question gate rejects. Bounded so a stuck socket can't grow memory.
    this._preConnectBuffer = [];   // 20ms frame Buffers awaiting connection
    this._preConnectBytes = 0;
    this.maxPreConnectBytes = options.maxPreConnectBytes ?? 640 * 1024; // ~20s @16k mono
    this.preConnectDropped = 0;
  }

  get isConnected() { return this.connected; }

  #url() {
    const p = new URLSearchParams();
    p.set('model', this.model);
    p.set('encoding', 'linear16');
    p.set('sample_rate', String(this.sampleRate));
    // NOTE: no channels param — Flux is mono-only and rejects an explicit
    // `channels=1`, returning HTTP 400 on the websocket handshake.
    p.set('eot_threshold', String(this.eotThreshold));
    p.set('eot_timeout_ms', String(this.eotTimeoutMs));
    if (this.eagerEotThreshold != null) {
      p.set('eager_eot_threshold', String(this.eagerEotThreshold));
    }
    // Multi-language model accepts language_hint; the EN model does not.
    if (/multi/.test(this.model)) {
      for (const lh of this.languageHints.slice(0, 4)) p.append('language_hint', lh);
    }
    // Keyterms for jargon (max sensible set for the query string).
    for (const k of this.keyterms.slice(0, 24)) p.append('keyterm', k);
    return `wss://${this.host}/v2/listen?${p.toString()}`;
  }

  // Open (or re-open) the persistent Flux socket. Returns { ok, error? }.
  connect(force = false) {
    if (this._ws && this.connected) return { ok: true };
    if (!this.apiKey) {
      this.lastError = { code: 'NO_API_KEY', message: 'Deepgram API key not configured' };
      this.emit('error', this.lastError);
      return { ok: false, error: 'no-api-key' };
    }
    if (force) this._teardown();

    this.log('[stt] connecting to Deepgram Flux', this.model);
    const ws = new this._Ws(this.#url(), {
      headers: {
        Authorization: 'token ' + this.apiKey,
        'User-Agent': 'WishAI-Voice/1.0',
      },
      handshakeTimeout: 10000,
    });
    this._ws = ws;
    this._configured = false;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.#sendConfigure();
      this.#startKeepalive();
      this.#flushPreConnect();
      this.emit('connected');
    });

    ws.on('message', (data) => {
      const ev = parseFluxMessage(data);
      if (!ev) return;
      if (ev.kind === 'connected' || ev.kind === 'configure-success') return;
      if (ev.kind === 'error') {
        this.lastError = { code: 'DEEPGRAM_ERROR', message: ev.message };
        this.log('[stt] Deepgram error:', ev.message);
        this.emit('error', this.lastError);
        return;
      }
      this.#dispatch(ev);
    });

    ws.on('error', (err) => {
      this.lastError = { code: 'WS_ERROR', message: String(err.message || err) };
      this.log('[stt] socket error:', err.message);
      this.emit('error', this.lastError);
    });

    ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._sendQueue = [];
      this._sendQueueBytes = 0;
      this.emit('disconnected');
      if (this._started && wasConnected && this.reconnectAttempts < this.maxReconnect) {
        this.#scheduleReconnect();
      }
    });

    return { ok: true };
  }

  #sendConfigure() {
    if (!this._configured) {
      const cfg = {
        type: 'Configure',
        keyterms: this.keyterms.slice(0, 100),
        thresholds: {
          eot_threshold: this.eotThreshold,
          eot_timeout_ms: this.eotTimeoutMs,
        },
      };
      if (this.eagerEotThreshold != null) cfg.thresholds.eager_eot_threshold = this.eagerEotThreshold;
      if (this.languageHints.length && /multi/.test(this.model)) cfg.language_hints = this.languageHints;
      this._ws.send(JSON.stringify(cfg));
      this._configured = true;
    }
  }

  #dispatch(ev) {
    switch (ev.kind) {
      case 'start':
        this.emit('turn-start', ev);
        this.emit('partial', { ...ev, event: 'start' });
        break;
      case 'update':
        this.emit('partial', { ...ev, event: 'update' });
        break;
      case 'eager-end':
        this.emit('eager-end', ev);
        break;
      case 'turn-resumed':
        this.emit('turn-resumed', ev);
        break;
      case 'final':
        this.emit('final', ev);
        break;
      default:
        break;
    }
  }

  #scheduleReconnect() {
    const delay = Math.min(20000, 500 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.log(`[stt] reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._started) this.connect(true);
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  // Stream a 20ms Int16 mono frame buffer at the configured sample rate.
  // Frames are grouped into ~80ms chunks (recommended for Flux).
  // While the socket is connecting/reconnecting, frames are buffered (bounded)
  // instead of dropped, so the opening words of an utterance survive.
  sendAudio(buf) {
    if (!Buffer.isBuffer(buf)) return false;
    if (!this.connected || !this._ws) {
      this.#bufferPreConnect(buf);
      return true;
    }
    this._sendQueue.push(buf);
    this._sendQueueBytes += buf.length;
    if (this._sendQueueBytes >= this.chunkBytes) this.#flushSendQueue();
    return true;
  }

  // Hold frames while not connected; flush the oldest once the bound is hit.
  #bufferPreConnect(buf) {
    this._preConnectBuffer.push(buf);
    this._preConnectBytes += buf.length;
    while (this._preConnectBytes > this.maxPreConnectBytes && this._preConnectBuffer.length) {
      const drop = this._preConnectBuffer.shift();
      this._preConnectBytes -= drop.length;
      this.preConnectDropped++;
    }
  }

  // Push buffered pre-connect frames into the live send pipeline (after Configure).
  #flushPreConnect() {
    if (!this._preConnectBuffer.length) return;
    const chunks = this._preConnectBuffer;
    this._preConnectBuffer = [];
    this._preConnectBytes = 0;
    for (const buf of chunks) {
      this._sendQueue.push(buf);
      this._sendQueueBytes += buf.length;
    }
    this.#flushSendQueue();
  }

  #flushSendQueue() {
    if (!this._sendQueue.length || !this._ws) return;
    const chunk = this._sendQueue.length === 1
      ? this._sendQueue[0]
      : Buffer.concat(this._sendQueue);
    this._sendQueue = [];
    this._sendQueueBytes = 0;
    try {
      this._ws.send(chunk);
      this.bytesSent += chunk.length;
      this._lastSentAt = Date.now();
    } catch (err) {
      // Socket not ready — log dropped frames for debugging
      this.log('[stt] send failed, frames dropped: ' + (err.message || err));
    }
  }

  // Send any remaining buffered audio (used at turn boundaries so the tail of
  // the last phrase reaches Flux before EndOfTurn is judged).
  flushSend() {
    if (this.connected) this.#flushSendQueue();
  }

  // Ask Flux to force-end the current turn (ControlMessage ForceEndTurn).
  forceEndTurn() {
    if (!this.connected || !this._ws) return false;
    try {
      this._ws.send(JSON.stringify({ type: 'ForceEndTurn' }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Compatibility seam. Flux ends turns natively (eot_threshold/eot_timeout),
  // so legacy callers that "finalized" via v1 Finalize are a no-op here.
  finalizeCurrent() {
    return this.forceEndTurn();
  }

  markListening() {
    // No-op: Flux streams continuously and decides turn boundaries itself.
  }

  markIdle() {
    this.reconnectAttempts = 0;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
  }

  startSession() {
    this._started = true;
    if (!this.connected && this.apiKey) this.connect(true);
  }

  stopSession() {
    this._started = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this.#stopKeepalive();
    this._teardown();
  }

  // Protocol-level ping so proxies / the provider don't drop an idle socket
  // during silence (no audio flows while the VAD gate is closed).
  #startKeepalive() {
    this.#stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (!this.connected || !this._ws) return;
      if (Date.now() - this._lastSentAt < this.keepaliveMs) return;
      try { this._ws.ping(); } catch (_) { /* socket closing */ }
    }, this.keepaliveMs);
    if (this._keepaliveTimer.unref) this._keepaliveTimer.unref();
  }

  #stopKeepalive() {
    if (this._keepaliveTimer) { clearInterval(this._keepaliveTimer); this._keepaliveTimer = null; }
  }

  _teardown() {
    this.#stopKeepalive();
    if (this._ws) {
      try {
        this._ws.removeAllListeners();
        this._ws.terminate();
      } catch (_) { /* ignore */ }
      this._ws = null;
    }
    this.connected = false;
    this._sendQueue = [];
    this._sendQueueBytes = 0;
    this._configured = false;
  }

  snapshot() {
    return {
      connected: this.connected,
      provider: 'deepgram-flux',
      api: 'v2',
      model: this.model,
      sampleRate: this.sampleRate,
      eotThreshold: this.eotThreshold,
      eagerEotThreshold: this.eagerEotThreshold ?? null,
      reconnectAttempts: this.reconnectAttempts,
      bytesSent: this.bytesSent,
      lastError: this.lastError,
    };
  }
}

module.exports = { StreamingSTT, parseFluxMessage };