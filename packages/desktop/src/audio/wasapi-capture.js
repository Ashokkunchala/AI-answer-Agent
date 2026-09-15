// wasapi-capture.js — unified async capture facade.
//
// Owns the native loopback capture (system or process) plus the DSP
// pipeline, and turns raw 48 kHz int16 chunks into ready-to-transcribe
// 16 kHz mono Pcm frames (level / vad / speech / classifier included).
// Mic capture is bridged in from the renderer (getUserMedia) when the user
// explicitly selects a microphone — the same facade feeds those frames.
'use strict';

const { EventEmitter } = require('events');
const { SystemLoopbackCapture } = require('./system-loopback-capture');
const { ProcessLoopbackCapture } = require('./process-loopback-capture');
const { AudioProcessingPipeline } = require('./audio-processing-pipeline');

const CAPTURE_STATE = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  CAPTURING: 'capturing',
  SWITCHING: 'switching',
  RECOVERING: 'recovering',
  ERROR: 'error',
};

const MAX_QUEUE = 400;

class WasapiCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate || 16000;
    this.blobRateMs = options.blobRateMs || 8;
    this.vadThreshold = options.vadThreshold ?? 0.015;
    this.noiseGate = options.noiseGate !== false;
    this.log = options.log || ((..._a) => { });

    this.state = CAPTURE_STATE.STOPPED;
    this.source = null;            // { kind, pid, deviceId, name, id }
    this.capture = null;           // SystemLoopbackCapture | ProcessLoopbackCapture | null
    this.pipeline = null;          // AudioProcessingPipeline
    this.queue = [];
    this._timer = null;
    this.lastFrameNs = null;
    this.lastChunkNs = null;
    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.chunksReceived = 0;
    this.lastFrame = null;
  }

  get isCapturing() { return this.state === CAPTURE_STATE.CAPTURING; }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  // Start capture on a given source descriptor (from AudioSourceManager).
  start(source) {
    if (this.state === CAPTURE_STATE.CAPTURING || this.state === CAPTURE_STATE.STARTING) {
      this.stop();
    }
    this.#setState(CAPTURE_STATE.STARTING);
    this.source = source || { kind: 'system' };

    const pipelineOptions = {
      inRate: 48000,
      channels: this.source.kind === 'mic' ? 1 : 2,
      outRate: this.sampleRate,
      frameMs: 20,
      vadThreshold: this.vadThreshold,
      noiseGate: this.noiseGate,
      label: 'voice-capture:' + this.source.kind,
    };
    this.pipeline = new AudioProcessingPipeline(pipelineOptions);
    this.queue = [];
    this.framesProcessed = 0;
    this.framesDropped = 0;
    this.chunksReceived = 0;
    this.lastFrameNs = null;
    this.lastChunkNs = null;

    if (this.source.kind === 'mic') {
      // Mic frames are pushed from the renderer as they arrive; no native capture.
      this.capture = null;
      this.#startDrain();
      this.#setState(CAPTURE_STATE.CAPTURING);
      this.log('[voice] mic capture armed (waiting for renderer frames)');
      this.emit('armed', { mic: true });
      return { ok: true, error: null };
    }

    if (this.source.kind === 'process') {
      this.capture = new ProcessLoopbackCapture({
        pid: this.source.pid,
        includeTree: this.source.includeTree !== false,
      });
      this.capture.on('chunk', (chunk) => this.#onChunk(chunk));
      this.capture.on('error', (err) => this.#onNativeError(err));
      this.capture.on('process-exit', (pid) => {
        this.log('[voice] captured process exited:', pid);
        this.emit('process-exit', pid);
      });
    } else {
      this.capture = new SystemLoopbackCapture({});
      this.capture.on('chunk', (chunk) => this.#onChunk(chunk));
      this.capture.on('error', (err) => this.#onNativeError(err));
    }

    const res = this.capture.start();
    if (!res.ok) {
      this.#onNativeError(new Error(res.error));
      return res;
    }
    this.#startDrain();
    this.#setState(CAPTURE_STATE.CAPTURING);
    this.emit('started', this.source);
    return { ok: true, error: null };
  }

  #startDrain() {
    if (this._timer) return;
    this._timer = setInterval(() => this.#drain(), this.blobRateMs);
    if (this._timer.unref) this._timer.unref();
  }

  #onChunk(chunk) {
    if (this.state !== CAPTURE_STATE.CAPTURING && this.state !== CAPTURE_STATE.RECOVERING) return;
    this.chunksReceived++;
    this.lastChunkNs = process.hrtime.bigint();
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      this.framesDropped++;
    }
    this.queue.push(chunk);
  }

  // Feed external mic PCM frames (48 kHz mono int16 Buffer) from renderer.
  pushMicPcm(buf) {
    if (this.state !== CAPTURE_STATE.CAPTURING) return;
    if (!this.source || this.source.kind !== 'mic') return;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    this.chunksReceived++;
    this.lastChunkNs = process.hrtime.bigint();
    if (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      this.framesDropped++;
    }
    this.queue.push(buf);
  }

  #drain() {
    if (!this.pipeline) return;
    let chunk = this.queue.shift();
    let guard = 0;
    while (chunk !== undefined && guard++ < MAX_QUEUE) {
      let frames = [];
      try {
        frames = this.pipeline.feed(chunk);
      } catch (err) {
        this.#onNativeError(err);
        return;
      }
      for (const f of frames) {
        this.framesProcessed++;
        this.lastFrameNs = process.hrtime.bigint();
        const out = {
          nowNs: this.lastFrameNs,
          ...f,
        };
        this.lastFrame = out;
        this.emit('frame', out);
      }
      chunk = this.queue.shift();
    }
  }

  #onNativeError(err) {
    this.log('[voice] capture error:', err && err.message);
    this.#setState(CAPTURE_STATE.ERROR);
    this.emit('error', err);
  }

  // Millis since the last raw chunk arrived (diagnostics / recovery aid).
  idleMs() {
    if (!this.lastChunkNs) return Infinity;
    return Number(process.hrtime.bigint() - this.lastChunkNs) / 1e6;
  }

  switchSource(source) {
    this.#setState(CAPTURE_STATE.SWITCHING);
    this.stop();
    return this.start(source);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.capture) {
      try { this.capture.stop(); } catch (_) { /* best effort */ }
      this.capture = null;
    }
    // Emit tail frames left in the pipeline (just-ended phrase at stop).
    if (this.pipeline) {
      try {
        const tail = this.pipeline.flush();
        for (const f of tail) {
          this.framesProcessed++;
          this.lastFrameNs = process.hrtime.bigint();
          this.emit('frame', { nowNs: this.lastFrameNs, ...f });
        }
      } catch (_) { /* ignore */ }
      this.pipeline = null;
    }
    this.queue = [];
    this.#setState(CAPTURE_STATE.STOPPED);
    this.emit('stopped');
  }

  snapshot() {
    return {
      state: this.state,
      source: this.source,
      sampleRate: this.sampleRate,
      framesProcessed: this.framesProcessed,
      framesDropped: this.framesDropped,
      chunksReceived: this.chunksReceived,
      idleMs: this.idleMs(),
    };
  }
}

module.exports = { WasapiCapture, CAPTURE_STATE };