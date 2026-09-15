// noise-suppressor.js — speech-preserving spectral noise gate.
// Streaming spectral-subtraction noise suppression:
//   - Estimates a slow noise floor (min-statistics style) per frequency bin
//   - Applies per-bin gains with spectral smoothing (reduces "musical noise")
//   - Uses 50%-overlap Hann STFT + overlap-add for artifact-free reconstruction
// Suppresses: fan, AC hum, static, hiss, keyboard/mouse transients, room tone.
// Preserves: human voice band (300 Hz – 4 kHz), word onsets/endings.
'use strict';

const { fftComplex, hannWindow } = require('./dsp-utils');

class NoiseSuppressor {
  constructor(options = {}) {
    this.fftSize = options.fftSize || 512;
    this.hopSize = options.hopSize || Math.floor(this.fftSize / 2);
    this.sampleRate = options.sampleRate || 16000;
    this.subtractionFactor = options.subtractionFactor || 1.5;
    this.noiseGateFloor = options.noiseGateFloor || 0.08;
    this.noiseSmooth = options.noiseSmooth || 0.06;
    this.binSmooth = options.binSmooth || 2;
    this.protectLow = options.protectLow || 300;
    this.protectHigh = options.protectHigh || 4000;

    this.numBins = Math.floor(this.fftSize / 2);
    this.analysisWindow = hannWindow(this.fftSize, false);
    this.synthesisWindow = hannWindow(this.fftSize, false);

    this.noiseEstimate = new Float64Array(this.numBins);
    this.smoothSpeech = new Float64Array(this.numBins);

    // Streaming state. All counters are absolute/monotonic so buffer pruning
    // can never cause samples to be processed more than once.
    this.inPend = [];        // un-processed input window (relative to inAbsStart)
    this.inAbsStart = 0;     // absolute stream index of inPend[0]
    this.outBuf = [];        // overlap-add output (relative to emitCount)
    this.emitCount = 0;      // absolute output samples already emitted
    this.emitStartAbs = 0;   // absolute index of outBuf[0]
    this.processedCount = 0; // frames processed (monotonic)
    this.enabled = true;
    this.framesProcessed = 0;
  }

  setEnabled(on) { this.enabled = !!on; }

  // Feed a Float64 mono chunk at `sampleRate`; returns processed Float64 samples.
  // Latency is one FFT frame (~32 ms @ 16 kHz) which keeps STT streaming snappy.
  process(input) {
    if (!this.enabled) return input;

    for (let i = 0; i < input.length; i++) this.inPend.push(input[i]);

    const out = [];

    // Process frames while full input is available: frame m needs samples up to m*hop+fftSize.
    while (this.processedCount * this.hopSize + this.fftSize <= this.inAbsStart + this.inPend.length) {
      const start = this.processedCount * this.hopSize - this.inAbsStart;
      const frame = this.inPend.slice(start, start + this.fftSize);
      const enhanced = this.processFrame(frame);
      const ostart = this.processedCount * this.hopSize; // absolute
      const rel = ostart - (this.emitStartAbs || 0);     // within outBuf
      if (rel < 0) throw new Error('noise-suppressor OLA underflow');
      while (this.outBuf.length < rel + this.fftSize) this.outBuf.length++;
      for (let i = 0; i < this.fftSize; i++) {
        this.outBuf[rel + i] = (this.outBuf[rel + i] || 0) + enhanced[i] * this.synthesisWindow[i];
      }
      this.processedCount++;
    }

    // Emit every output sample whose last covering frame is done.
    // Output sample k is finalized once frame floor(k/hop) has been processed,
    // so the safe frontier is processedCount*hop.
    const avail = this.processedCount * this.hopSize;
    while (this.emitCount < avail) {
      out.push(this.outBuf[this.emitCount - (this.emitStartAbs || 0)] || 0);
      this.emitCount++;
    }

    // Prune emitted output (free slots before the emit cursor).
    const spent = this.emitCount - (this.emitStartAbs || 0);
    if (spent > this.fftSize * 4) {
      this.outBuf.splice(0, spent);
      this.emitStartAbs = this.emitCount;
    }

    // Prune consumed input (anything before the next frame's start).
    const keepFromAbs = this.processedCount * this.hopSize;
    if (keepFromAbs - this.inAbsStart > 0) {
      this.inPend = this.inPend.slice(keepFromAbs - this.inAbsStart);
      this.inAbsStart = keepFromAbs;
    }

    return Float64Array.from(out);
  }

  processFrame(frame) {
    const N = this.fftSize;
    const ctx = new Float64Array(N * 2);
    for (let i = 0; i < N; i++) {
      ctx[i * 2] = frame[i] * this.analysisWindow[i];
    }
    fftComplex(ctx, false);

    // Magnitudes
    for (let b = 0; b < this.numBins; b++) {
      this.smoothSpeech[b] += (Math.hypot(ctx[b * 2], ctx[b * 2 + 1]) - this.smoothSpeech[b]) * 0.4;
    }

    // Noise floor estimate: slowly chase the lower envelope of the spectrum.
    // Voice bins adapt more slowly so speech is never eaten.
    const binHz = this.sampleRate / N;
    for (let b = 0; b < this.numBins; b++) {
      const hz = b * binHz;
      const isVoice = hz >= this.protectLow && hz <= this.protectHigh;
      const adapt = isVoice ? this.noiseSmooth * 0.5 : this.noiseSmooth;
      const candidate = Math.min(this.smoothSpeech[b], 4 * this.noiseEstimate[b] + 1e-4);
      this.noiseEstimate[b] += (candidate - this.noiseEstimate[b]) * adapt;
    }

    // Per-bin gain with mild frequency smoothing.
    const binGains = new Float64Array(this.numBins);
    for (let b = 0; b < this.numBins; b++) {
      const mag = this.smoothSpeech[b];
      const est = this.noiseEstimate[b];
      let g;
      if (mag > est + 1e-6) {
        g = 1 - (this.subtractionFactor * est) / (mag + 1e-6);
        g = Math.max(this.noiseGateFloor, g);
      } else {
        g = this.noiseGateFloor;
      }
      const hz = b * binHz;
      if (hz >= this.protectLow && hz <= this.protectHigh) g = Math.max(g, 0.35);
      if (hz < 60) g = Math.min(g, 0.2);
      binGains[b] = g;
    }

    const gains = new Float64Array(this.numBins);
    for (let b = 0; b < this.numBins; b++) {
      let acc = 0;
      let cnt = 0;
      for (let k = -this.binSmooth; k <= this.binSmooth; k++) {
        const j = b + k;
        if (j >= 0 && j < this.numBins) { acc += binGains[j]; cnt++; }
      }
      gains[b] = acc / cnt;
    }

    // Apply gains to full spectrum (mirrored bins for real signal).
    for (let b = 0; b < this.numBins; b++) {
      const g = gains[b];
      const re = ctx[b * 2];
      const im = ctx[b * 2 + 1];
      ctx[b * 2] = re * g;
      ctx[b * 2 + 1] = im * g;
      const mb = N - b;
      if (mb < N) {
        ctx[mb * 2] *= g;
        ctx[mb * 2 + 1] *= g;
      }
    }
    // DC and Nyquist handled via b=0 & reflection above.

    fftComplex(ctx, true);

    // Normalize: analysis window doubles amplitude, 2x OLA overlap adds 1.5x.
    const kNorm = 2 / 3;
    const out = new Float64Array(N);
    for (let i = 0; i < N; i++) out[i] = ctx[i * 2] * kNorm;
    this.framesProcessed++;
    return out;
  }
}

module.exports = { NoiseSuppressor };