// dsp-utils.js — lightweight pure-JS DSP helpers (FFT, windows, resample)
'use strict';

// In-place radix-2 complex FFT. arr = [re0, im0, re1, im1, ...], length = 2*N.
// N must be a power of two. inverse=true performs inverse (unscaled) FFT.
function fftComplex(arr, inverse) {
  const n = arr.length / 2;
  if (n < 2) return;
  const bits = Math.log2(n);
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      swap(arr, i, j);
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const ai = 2 * (i + k);
        const bi = 2 * (i + k + len / 2);
        const tRe = arr[bi] * curRe - arr[bi + 1] * curIm;
        const tIm = arr[bi] * curIm + arr[bi + 1] * curRe;
        arr[bi] = arr[ai] - tRe;
        arr[bi + 1] = arr[ai + 1] - tIm;
        arr[ai] += tRe;
        arr[ai + 1] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < arr.length; i += 2) {
      arr[i] /= n;
      arr[i + 1] /= n;
    }
  }
}

function swap(arr, a, b) {
  a *= 2;
  b *= 2;
  let t;
  for (let k = 0; k < 2; k++) {
    t = arr[a + k];
    arr[a + k] = arr[b + k];
    arr[b + k] = t;
  }
}

// Hann window of length n, normalized so overlapping 50% yields unity gain.
function hannWindow(n, normalized) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  if (normalized) {
    // Scale so that two overlapping Hann windows sum to ~1.0 at midpoints.
    const norm = 1.5; // sum of 50%-overlap Hann windows ≈ 1.5
    for (let i = 0; i < n; i++) w[i] /= norm;
  }
  return w;
}

// Convert stereo/mono interleaved int16 PCM (little-endian, signed) into a
// mono Float64 array. Accepts Buffer or ArrayBuffer/typed array.
function interleavedInt16ToMonoF64(buf, channels) {
  const u8 = buf instanceof Uint8Array
    ? buf
    : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength || buf.length);
  const frameCount = Math.floor(u8.byteLength / (2 * channels));
  const out = new Float64Array(frameCount);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  for (let f = 0; f < frameCount; f++) {
    let s = 0;
    for (let c = 0; c < channels; c++) {
      s += dv.getInt16((f * channels + c) * 2, true) / 32768;
    }
    out[f] = s / channels;
  }
  return out;
}

// Convert a Float64 (or Float32) mono array into int16 little-endian Buffer.
function monoF64ToInt16Buffer(input) {
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i++) {
    let v = input[i];
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    out.writeInt16LE(v < 0 ? v * 0x8000 : v * 0x7FFF, i * 2);
  }
  return out;
}

// Linear-interpolation resampler streaming helper.
class StreamResampler {
  constructor(fromRate, toRate) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.ratio = fromRate / toRate; // source samples per output sample
    this.buf = [];
    this.absStart = 0; // absolute stream index of buf[0]
    this.emitPos = 0;  // number of output samples already produced
  }

  // Push a contiguous chunk of source samples; returns resampled chunk.
  push(samples) {
    if (!samples.length) return new Float64Array(0);
    for (let i = 0; i < samples.length; i++) this.buf.push(samples[i]);

    const out = [];
    // Output sample n is a linear interpolation of input at absolute position n*ratio.
    while ((this.emitPos + 1) * this.ratio <= this.absStart + this.buf.length) {
      const p = this.emitPos * this.ratio;
      const i = Math.floor(p) - this.absStart;
      const frac = p - (this.absStart + i);
      const a = this.buf[i] === undefined ? 0 : this.buf[i];
      const b = i + 1 < this.buf.length ? this.buf[i + 1] : a;
      out.push(a + (b - a) * frac);
      this.emitPos++;
    }

    // Keep just enough input for future interpolation (next position = emitPos*ratio).
    const keepFromAbs = Math.max(0, Math.floor(this.emitPos * this.ratio) - 1);
    if (keepFromAbs - this.absStart > 32) {
      this.buf = this.buf.slice(keepFromAbs - this.absStart);
      this.absStart = keepFromAbs;
    }
    return Float64Array.from(out);
  }
}

// Streaming high-pass (or low-pass) biquad filter (RBJ cookbook).
class Biquad {
  constructor(type, freq, sampleRate, q = 0.707, gainDb = 0) {
    this.reset(type, freq, sampleRate, q, gainDb);
  }

  reset(type, freq, sampleRate, q = 0.707, gainDb = 0) {
    const A = Math.pow(10, gainDb / 20);
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    let b0 = 0; let b1 = 0; let b2 = 0; let a0 = 1; let a1 = 0; let a2 = 0;
    const cosw0 = Math.cos(w0);
    if (type === 'highpass') {
      b0 = (1 + cosw0) / 2;
      b1 = -(1 + cosw0);
      b2 = (1 + cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    } else if (type === 'lowpass') {
      b0 = (1 - cosw0) / 2;
      b1 = 1 - cosw0;
      b2 = (1 - cosw0) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw0;
      a2 = 1 - alpha;
    } else if (type === 'peaking') {
      b0 = 1 + alpha * A;
      b1 = -2 * cosw0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * cosw0;
      a2 = 1 - alpha / A;
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  processBlock(arr) {
    for (let i = 0; i < arr.length; i++) arr[i] = this.process(arr[i]);
    return arr;
  }
}

// Simple fixed-point-free AGC: normalizes RMS toward a target over a sliding window.
class LevelNormalizer {
  constructor({ targetRms = 0.14, attack = 0.35, release = 0.6, maxGain = 6, minGain = 0.5 } = {}) {
    this.targetRms = targetRms;
    this.attack = attack;
    this.release = release;
    this.maxGain = maxGain;
    this.minGain = minGain;
    this.gain = 1;
  }

  processBlock(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    const rms = Math.sqrt(sum / Math.max(1, arr.length)) || 0;
    const desired = rms > 1e-6 ? this.targetRms / rms : this.maxGain * this.gain;
    const targetGain = Math.min(this.maxGain, Math.max(this.minGain, desired));
    const coeff = rms >= this.targetRms ? this.attack : this.release;
    this.gain += (targetGain - this.gain) * coeff;
    for (let i = 0; i < arr.length; i++) arr[i] *= this.gain;
    return arr;
  }
}

// RMS of a Float array.
function rms(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, arr.length));
}

module.exports = {
  fftComplex,
  hannWindow,
  interleavedInt16ToMonoF64,
  monoF64ToInt16Buffer,
  StreamResampler,
  Biquad,
  LevelNormalizer,
  rms,
};