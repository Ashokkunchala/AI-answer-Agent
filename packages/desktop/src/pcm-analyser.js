// pcm-analyser.js — AnalyserNode-compatible shim for WASAPI engine mode.
// The AudioVisualizer expects a WebAudio AnalyserNode; in engine mode there is
// no WebAudio graph, so this class computes a real FFT from the incoming PCM
// frames and exposes the same surface: fftSize, frequencyBinCount,
// getByteFrequencyData().
'use strict';

function fftRadix2(arr) {
  const n = arr.length / 2;
  if (n < 2) return;
  const bits = Math.log2(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = arr[2 * i];
      arr[2 * i] = arr[2 * j];
      arr[2 * j] = t;
      t = arr[2 * i + 1];
      arr[2 * i + 1] = arr[2 * j + 1];
      arr[2 * j + 1] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = 2 * (i + k);
        const b = 2 * (i + k + len / 2);
        const tRe = arr[b] * curRe - arr[b + 1] * curIm;
        const tIm = arr[b] * curIm + arr[b + 1] * curRe;
        arr[b] = arr[a] - tRe;
        arr[b + 1] = arr[a + 1] - tIm;
        arr[a] += tRe;
        arr[a + 1] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

export class PcmAnalyser {
  constructor(options = {}) {
    this.fftSize = options.fftSize || 256;
    this.smoothingTimeConstant = options.smoothingTimeConstant || 0.7;
    this.sampleRate = options.sampleRate || 16000;
    this._ring = new Float32Array(4096);
    this._pos = 0;
    this._smoothed = null;
  }

  get frequencyBinCount() {
    return this.fftSize / 2;
  }

  // Feed raw int16 PCM (ArrayBuffer or Int16Array).
  feed(pcm) {
    let arr;
    if (pcm instanceof ArrayBuffer) arr = new Int16Array(pcm);
    else if (pcm instanceof Int16Array) arr = pcm;
    else if (pcm && pcm.buffer && typeof pcm.length === 'number') arr = new Int16Array(pcm.buffer, pcm.byteOffset || 0, pcm.length);
    else return;

    for (let i = 0; i < arr.length; i++) {
      this._ring[this._pos] = arr[i] / 32768;
      this._pos = (this._pos + 1) % this._ring.length;
    }
  }

  getByteFrequencyData(dataArray) {
    const N = this.fftSize;
    const ctx = new Float64Array(N * 2);
    const first = this._pos - N + Math.ceil(N * 0.25);
    for (let i = 0; i < N; i++) {
      const idx = (first + i + this._ring.length * 4) % this._ring.length;
      ctx[i * 2] = this._ring[idx] || 0;
    }
    fftRadix2(ctx);

    const bins = this.frequencyBinCount;
    for (let b = 0; b < bins; b++) {
      const re = ctx[b * 2];
      const im = ctx[b * 2 + 1];
      const mag = Math.hypot(re, im) / N;
      const db = Math.max(-90, 20 * Math.log10(mag + 1e-10));
      let v = ((db + 90) / 80) * 255; // -90dB .. -10dB -> 0..255
      v = Math.max(0, Math.min(255, v));
      if (this._smoothed && this._smoothed.length === dataArray.length) {
        const s = 1 - (this.smoothingTimeConstant || 0);
        v = this._smoothed[b] * (1 - s) + v * s;
      }
      if (!this._smoothed || this._smoothed.length !== dataArray.length) {
        this._smoothed = new Float64Array(dataArray.length);
      }
      this._smoothed[b] = v;
      dataArray[b] = Math.round(v);
    }
  }

  getByteTimeDomainData(dataArray) {
    const N = this.fftSize;
    for (let i = 0; i < N && i < dataArray.length; i++) {
      const idx = (this._pos - N + i + this._ring.length * 4) % this._ring.length;
      dataArray[i] = Math.round(((this._ring[idx] * 0.5) + 0.5) * 255);
    }
  }
}