// Deepgram Flux WebSocket STT Provider
// Real-time streaming with server-side VAD and EndOfTurn detection
// https://developers.deepgram.com/docs/getting-started-live
//
// Key difference from basic Deepgram:
// - Uses Flux model (latest, best accuracy)
// - Server-side VAD handles speech detection (no local VAD needed for STT)
// - EndOfTurn event signals when interviewer finishes speaking
// - Persistent connection stays open between utterances
// - Partial transcripts arrive in real-time as audio streams

import { SpeechToTextProvider } from './base.js';
import { getDeepgramKeywords, correctTranscript } from '../vocabulary.js';

export class DeepgramProvider extends SpeechToTextProvider {
  constructor(config = {}) {
    super(config);
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.pingInterval = null;
    this.lastActivity = Date.now();
    this._destroyed = false;
    this._reconnecting = false;
    this._manualDisconnect = false;
    this._pendingAudio = [];
    this._maxPendingAudioFrames = 50;
  }

  get apiKey() { return this.config.apiKey || ''; }
  get language() { return this.config.language || 'en'; }
  get model() { return this.config.model || this.config.sttModel || 'nova-3'; }
  get isFlux() { return /^flux-/i.test(this.model); }
  get sampleRate() { return this.config.sampleRate || 16000; }

  get endpoint() {
    if (this.config.endpoint) return this.config.endpoint;

    if (this.isFlux) {
      const params = new URLSearchParams({
        model: this.model,
        encoding: 'linear16',
        sample_rate: String(this.sampleRate),
      });
      const eager = Number(this.config.eagerEotThreshold);
      const threshold = Number(this.config.eotThreshold);
      const timeout = Number(this.config.eotTimeoutMs);
      if (Number.isFinite(eager) && eager >= 0.3 && eager <= 0.9) params.set('eager_eot_threshold', String(eager));
      if (Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1) params.set('eot_threshold', String(threshold));
      if (Number.isFinite(timeout) && timeout > 0) params.set('eot_timeout_ms', String(timeout));

      // Flux uses repeated keyterm parameters rather than Nova's weighted
      // keywords syntax. Keep the vocabulary bounded for handshake size.
      const terms = getDeepgramKeywords().split(',').map((v) => v.split(':')[0]).filter(Boolean).slice(0, 50);
      for (const term of terms) params.append('keyterm', term);
      return `wss://api.deepgram.com/v2/listen?${params.toString()}`;
    }

    const keywords = getDeepgramKeywords();
    return `wss://api.deepgram.com/v1/listen` +
      `?model=${this.model}` +
      `&language=${this.language}` +
      `&encoding=linear16` +
      `&sample_rate=${this.sampleRate}` +
      `&channels=1` +
      `&interim_results=true` +
      `&endpointing=300` +
      `&utterance_end_ms=800` +
      `&smart_format=true` +
      `&keywords=${encodeURIComponent(keywords)}`;
  }

  async connect() {
    if (this._destroyed && this._manualDisconnect) {
      // A deliberate disconnect can be followed by a fresh connect/start.
      this._destroyed = false;
    }
    if (this._destroyed) throw new Error('Provider destroyed');
    if (!this.apiKey) throw new Error('Deepgram API key required');
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    this._reconnecting = false;
    this._manualDisconnect = false;

    return new Promise((resolve, reject) => {
      try {
        const url = this.endpoint;
        console.log(`[DeepgramProvider] Connecting to ${this.model}...`);
        // Browser/Electron WebSocket does not allow arbitrary Authorization
        // headers. Deepgram supports the "token, <API_KEY>" subprotocol for
        // client-side WebSocket authentication.
        this.ws = new WebSocket(url, ['token', this.apiKey]);
        this.ws.binaryType = 'arraybuffer';

        const timeout = setTimeout(() => {
          if (this.ws) this.ws.close();
          reject(new Error('Deepgram connection timeout (10s)'));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(timeout);
          this.connected = true;
          this.reconnectAttempts = 0;
          this._startPing();
          // Replay only the short reconnect buffer. This reduces transcript
          // gaps without allowing an outage to grow memory without bounds.
          if (this._pendingAudio.length) {
            const pending = this._pendingAudio.splice(0);
            for (const frame of pending) {
              if (this.ws?.readyState !== WebSocket.OPEN) break;
              try { this.ws.send(frame); } catch (_) { break; }
            }
          }
          console.log(`[DeepgramProvider] Connected (${this.isFlux ? 'Flux v2' : 'Nova v1'} streaming active)`);
          this._emit('connected', { provider: 'deepgram', model: this.model });
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.lastActivity = Date.now();
          this._handleMessage(event.data);
        };

        this.ws.onerror = (event) => {
          clearTimeout(timeout);
          const msg = 'WebSocket error';
          this._emit('error', { type: 'connection', message: msg });
          if (!this.connected) reject(new Error(msg));
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          this._stopPing();
          const wasConnected = this.connected;
          this.connected = false;

          if (event.code === 1000) {
            // Clean close — don't reconnect
            this._emit('disconnected', { code: event.code, reason: event.reason, wasConnected });
          } else if (wasConnected && !this._destroyed) {
            // Unexpected close — reconnect
            this._emit('disconnected', { code: event.code, reason: event.reason, wasConnected });
            this._attemptReconnect();
          }
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  async disconnect() {
    this._manualDisconnect = true;
    this._destroyed = true;
    this._stopPing();
    this._pendingAudio.length = 0;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'Client disconnect'); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this._emit('disconnected', { code: 1000, reason: 'Client disconnect', wasConnected: false });
  }

  async sendAudio(audioData) {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (!this._destroyed && audioData) {
        if (this._pendingAudio.length >= this._maxPendingAudioFrames) {
          this._pendingAudio.shift();
        }
        // Copy the frame because callers often reuse the underlying buffer.
        const copy = audioData instanceof ArrayBuffer
          ? audioData.slice(0)
          : ArrayBuffer.isView(audioData)
            ? audioData.buffer.slice(audioData.byteOffset, audioData.byteOffset + audioData.byteLength)
            : audioData;
        this._pendingAudio.push(copy);
      }
      return false;
    }
    try {
      this.ws.send(audioData);
      this.lastActivity = Date.now();
      return true;
    } catch (e) {
      this._emit('error', { type: 'send', message: e.message });
      return false;
    }
  }

  // Send close message to flush final transcript
  sendClose() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
    }
  }

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data);

      if (this.isFlux && msg.type === 'TurnInfo') {
        const transcript = msg.transcript || '';
        const corrected = correctTranscript(transcript.trim());
        const confidence = Number(msg.end_of_turn_confidence || 0);
        const words = msg.words || [];

        if (transcript.trim()) {
          if (msg.event === 'EndOfTurn') {
            this._emit('final', {
              transcript: corrected,
              confidence,
              words,
              speechFinal: true,
              turnIndex: msg.turn_index,
            });
          } else {
            // Update, EagerEndOfTurn and TurnResumed all represent the current
            // live turn. The TranscriptManager treats them as partials.
            this._emit('partial', {
              transcript: corrected,
              confidence,
              turnIndex: msg.turn_index,
            });
          }
        }

        if (msg.event === 'EndOfTurn') {
          this._emit('utterance-end', {
            lastWordEnd: msg.audio_window_end || 0,
            turnIndex: msg.turn_index,
          });
        }
      } else if (msg.type === 'Results') {
        const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
        const confidence = msg.channel?.alternatives?.[0]?.confidence || 0;
        const isFinal = msg.is_final === true;
        const speechFinal = msg.speech_final === true;

        if (transcript.trim()) {
          if (isFinal || speechFinal) {
            const corrected = correctTranscript(transcript.trim());
            this._emit('final', {
              transcript: corrected,
              confidence,
              words: msg.channel?.alternatives?.[0]?.words || [],
              duration: msg.channel?.alternatives?.[0]?.transcript_duration || 0,
              speechFinal,
            });
          } else {
            this._emit('partial', {
              transcript: transcript.trim(),
              confidence,
            });
          }
        }
      } else if (msg.type === 'UtteranceEnd') {
        // Deepgram detected end of turn (interviewer stopped speaking)
        // This is the key event for real-time pipeline
        console.log('[DeepgramProvider] UtteranceEnd received');
        this._emit('utterance-end', {
          lastWordEnd: msg.last_word_end || 0,
        });
      } else if (msg.type === 'Error') {
        this._emit('error', {
          type: 'stt',
          message: msg.error || msg.description || 'Deepgram error',
          code: msg.code || 0,
        });
      }
    } catch (e) {
      // Binary data or malformed - skip
    }
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ type: 'KeepAlive' })); } catch (e) {}
      }
    }, 4000);
  }

  _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  _attemptReconnect() {
    if (this._destroyed || this._reconnecting || this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this._emit('error', { type: 'reconnect', message: `Connection lost after ${this.maxReconnectAttempts} attempts` });
      }
      return;
    }

    this._reconnecting = true;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;

    console.log(`[DeepgramProvider] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this._destroyed) return;
      try {
        await this.connect();
        this._reconnecting = false;
      } catch (e) {
        this._reconnecting = false;
        this._attemptReconnect();
      }
    }, delay);
  }

  destroy() {
    this._destroyed = true;
    this._stopPing();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(1000, 'Destroyed'); } catch (e) {}
      this.ws = null;
    }
    this.connected = false;
    this.listeners.clear();
  }
}
