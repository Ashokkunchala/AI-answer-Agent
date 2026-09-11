// SpeechToTextProvider - Abstract interface for STT providers
// Implement this interface to add new STT providers

export class SpeechToTextProvider {
  constructor(config = {}) {
    this.config = config;
    this.connected = false;
    this.listeners = new Map();
  }

  // Lifecycle
  async connect() { throw new Error('Not implemented'); }
  async disconnect() { throw new Error('Not implemented'); }
  isConnected() { return this.connected; }

  // Audio
  async sendAudio(audioData) { throw new Error('Not implemented'); }

  // Events
  onPartialTranscript(callback) { this._on('partial', callback); }
  onFinalTranscript(callback) { this._on('final', callback); }
  onError(callback) { this._on('error', callback); }
  onConnected(callback) { this._on('connected', callback); }
  onDisconnected(callback) { this._on('disconnected', callback); }
  onLatency(callback) { this._on('latency', callback); }

  _on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event) || [];
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error(`STT ${event} listener error:`, e); }
    }
  }

  destroy() {
    this.listeners.clear();
    this.connected = false;
  }
}
