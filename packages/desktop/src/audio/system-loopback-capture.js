// system-loopback-capture.js — WASAPI full system loopback capture.
//
// Wraps the native `loopback-capture` addon's startSystemAudio() path: it
// pulls everything the DEFAULT render endpoint mixes, as 16-bit stereo
// 48 kHz interleaved PCM. Raw chunks are forwarded verbatim; silence bytes
// are intentionally NOT filtered here (the DSP pipeline + VAD handle
// non-speech downstream, and Deepgram benefits from continuous audio).
'use strict';

const LoopbackCapture = require('loopback-capture').LoopbackCapture;
const { EventEmitter } = require('events');

class SystemLoopbackCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.label = options.label || 'system-loopback';
    this._capture = null;
    this.running = false;
    this.startedAt = null;
    this.byteCount = 0;
    this.chunksSinceStart = 0;
  }

  get isRunning() { return this.running; }

  start() {
    if (this.running) return { ok: true, error: 'already-running' };
    const cap = new LoopbackCapture();
    const onChunk = (chunk) => this._onChunk(chunk);
    try {
      cap.startSystemAudio(onChunk);
      this._capture = cap;
      this.running = true;
      this.startedAt = Date.now();
      this.chunksSinceStart = 0;
      this.emit('started');
      return { ok: true, error: null };
    } catch (err) {
      this.emit('error', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  _onChunk(chunk) {
    if (!this.running) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.byteCount += chunk.byteLength;
    this.chunksSinceStart++;
    this.emit('chunk', chunk);
  }

  restart() {
    this.stop();
    return this.start();
  }

  stop() {
    if (!this.running && !this._capture) return;
    this.running = false;
    const cap = this._capture;
    this._capture = null;
    if (cap) {
      try { cap.stop(); } catch (_) { /* best effort */ }
    }
    this.emit('stopped');
  }

  snapshot() {
    return {
      running: this.running,
      startedAt: this.startedAt,
      bytes: this.byteCount,
      chunks: this.chunksSinceStart,
    };
  }
}

module.exports = { SystemLoopbackCapture };