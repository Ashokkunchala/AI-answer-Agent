// Deepgram WebSocket STT Provider
// Real-time streaming via WebSocket with VAD
// https://developers.deepgram.com/docs/getting-started-live

import { SpeechToTextProvider } from './base.js';

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
  }

  get apiKey() { return this.config.apiKey || ''; }
  get language() { return this.config.language || 'en'; }
  get model() { return this.config.model || 'nova-3'; }
  get sampleRate() { return this.config.sampleRate || 48000; }
  get endpoint() {
    return this.config.endpoint || `wss://api.deepgram.com/v1/listen?model=${this.model}&language=${this.language}&encoding=linear16&sample_rate=${this.sampleRate}&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&smart_format=true`;
  }

  async connect() {
    if (this._destroyed) throw new Error('Provider destroyed');
    if (!this.apiKey) throw new Error('Deepgram API key required');

    return new Promise((resolve, reject) => {
      try {
        const url = this.endpoint;
        this.ws = new WebSocket(url);
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
          this._emit('connected', { provider: 'deepgram' });
          resolve();
        };

        this.ws.onmessage = (event) => {
          this.lastActivity = Date.now();
          this._handleMessage(event.data);
        };

        this.ws.onerror = (event) => {
          clearTimeout(timeout);
          const msg = event.message || event.error || 'WebSocket error';
          this._emit('error', { type: 'connection', message: msg });
          if (!this.connected) reject(new Error(msg));
        };

        this.ws.onclose = (event) => {
          clearTimeout(timeout);
          this._stopPing();
          const wasConnected = this.connected;
          this.connected = false;
          this._emit('disconnected', { code: event.code, reason: event.reason, wasConnected });
          if (wasConnected) this._attemptReconnect();
        };
      } catch (e) {
        reject(e);
      }
    });
  }

  async disconnect() {
    this._destroyed = true;
    this._stopPing();
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

  // Send close message to finalize transcript
  sendClose() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
    }
  }

  // Send punctuation toggle
  sendTogglePunctuation() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'TogglePunctuation' })); } catch (e) {}
    }
  }

  _handleMessage(data) {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'Results') {
        const transcript = msg.channel?.alternatives?.[0]?.transcript || '';
        const confidence = msg.channel?.alternatives?.[0]?.confidence || 0;
        const isFinal = msg.is_final === true;
        const speechFinal = msg.speech_final === true;

        if (transcript.trim()) {
          if (isFinal || speechFinal) {
            this._emit('final', {
              transcript: transcript.trim(),
              confidence,
              words: msg.channel?.alternatives?.[0]?.words || [],
              duration: msg.channel?.alternatives?.[0]?.transcript_duration || 0,
            });
          } else {
            this._emit('partial', {
              transcript: transcript.trim(),
              confidence,
            });
          }
        }
      } else if (msg.type === 'UtteranceEnd') {
        // Utterance ended without final - flush partial
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
    }, 15000);
  }

  _stopPing() {
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
  }

  _attemptReconnect() {
    if (this._destroyed || this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._emit('error', { type: 'reconnect', message: `Connection lost after ${this.maxReconnectAttempts} attempts` });
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 10000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(async () => {
      if (this._destroyed) return;
      try {
        await this.connect();
      } catch (e) {
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
