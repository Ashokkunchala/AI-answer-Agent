// Whisper Worker STT Provider
// Uses the existing Cloudflare Worker /v1/audio/transcriptions endpoint
// Buffers audio chunks and sends complete utterances on flush (VAD end)

import { SpeechToTextProvider } from './base.js';

export class WhisperProvider extends SpeechToTextProvider {
  constructor(config = {}) {
    super(config);
    this.workerUrl = config.workerUrl || '';
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'whisper-large-v3';
    this.language = config.language || 'en';
    this.sampleRate = config.sampleRate || 48000;
    this._destroyed = false;
    this._connected = false;
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    this._processing = false;
    this._sessionStartTime = 0;
  }

  get endpoint() {
    return this.workerUrl.replace(/\/+$/, '') + '/v1/audio/transcriptions';
  }

  async connect() {
    if (this._destroyed) throw new Error('Provider destroyed');
    if (!this.workerUrl) throw new Error('Worker URL required for Whisper provider');

    console.log('[WhisperProvider] Connecting to worker:', this.workerUrl);
    
    // Verify the endpoint is reachable with short timeout
    try {
      const res = await fetch(this.workerUrl.replace(/\/+$/, '') + '/health', {
        signal: AbortSignal.timeout(3000)
      });
      if (!res.ok) throw new Error(`Worker health check failed: ${res.status}`);
      console.log('[WhisperProvider] Worker health check passed');
    } catch (e) {
      const msg = e.name === 'TimeoutError' 
        ? `Worker at ${this.workerUrl} is not responding (timeout)`
        : `Cannot reach worker at ${this.workerUrl}: ${e.message}`;
      console.error('[WhisperProvider]', msg);
      throw new Error(msg);
    }

    this._connected = true;
    this.connected = true;
    this._emit('connected', { provider: 'whisper', workerUrl: this.workerUrl });
    return true;
  }

  async disconnect() {
    this._destroyed = true;
    this._connected = false;
    this.connected = false;
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    this._processing = false;
    this._emit('disconnected', { code: 1000, reason: 'Client disconnect', wasConnected: false });
  }

  async sendAudio(audioData) {
    if (!this._connected || this._destroyed) return false;

    // Buffer the audio chunk
    this._audioBuffer.push(audioData);
    this._audioBufferBytes += audioData.byteLength || audioData.size || 0;

    return true;
  }

  // Called by VoiceService when VAD detects end of speech
  // Sends the complete buffered utterance for transcription
  async sendClose() {
    if (this._destroyed || this._audioBuffer.length === 0) return;

    if (this._processing) return; // Already processing a flush

    this._processing = true;
    const startTime = Date.now();

    try {
      // Concatenate all buffered audio chunks
      const totalBytes = this._audioBuffer.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.size || 0), 0);
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of this._audioBuffer) {
        const bytes = chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : ArrayBuffer.isView(chunk)
            ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : new Uint8Array(chunk);
        merged.set(bytes, offset);
        offset += bytes.byteLength;
      }

      // Clear the buffer
      this._audioBuffer = [];
      this._audioBufferBytes = 0;

      // Skip tiny buffers (less than 0.1s of audio at 16kHz 16-bit mono = 3200 bytes)
      if (totalBytes < 3200) {
        this._processing = false;
        return;
      }

      // Convert to base64 (real WAV container — raw PCM labeled audio/webm
      // has never decoded in Whisper).
      const wav = this._toWav(merged, this.sampleRate, 1, 16);
      const base64 = this._arrayBufferToBase64(wav.buffer);

      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          file: base64,
          mime_type: 'audio/wav',
          sample_rate: this.sampleRate,
          language: this.language,
        }),
        signal: AbortSignal.timeout(15000),
      });

      const latency = Date.now() - startTime;
      this._emit('latency', { stt: latency });

      if (!res.ok) {
        const errText = await res.text().catch(() => 'Unknown error');
        this._emit('error', { type: 'stt', message: `STT ${res.status}: ${errText}`, code: res.status });
        return;
      }

      const result = await res.json();
      const text = result?.text || '';

      if (text.trim()) {
        this._emit('final', {
          transcript: text.trim(),
          confidence: 0.9,
          words: result.segments || [],
          duration: result.duration || 0,
        });
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        this._emit('error', { type: 'stt', message: e.message });
      }
    } finally {
      this._processing = false;
    }
  }

  _toWav(pcmBytes, sampleRate, channels, bitsPerSample) {
    const numSamples = Math.floor(pcmBytes.byteLength / (bitsPerSample / 8 * channels));
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);
    const header = new Uint8Array(44);
    const dv = new DataView(header.buffer);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i); };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + pcmBytes.byteLength, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);            // PCM
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    dv.setUint32(40, pcmBytes.byteLength, true);

    const out = new Uint8Array(44 + pcmBytes.byteLength);
    out.set(header, 0);
    out.set(pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes), 44);
    return out;
  }

  _arrayBufferToBase64(buffer) {
    let bytes;
    if (buffer instanceof ArrayBuffer) {
      bytes = new Uint8Array(buffer);
    } else if (ArrayBuffer.isView(buffer)) {
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else {
      return String(buffer);
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  destroy() {
    this._destroyed = true;
    this._connected = false;
    this.connected = false;
    this._audioBuffer = [];
    this._audioBufferBytes = 0;
    this._processing = false;
    this.listeners.clear();
  }
}
