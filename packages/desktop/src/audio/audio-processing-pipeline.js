// audio-processing-pipeline.js — the audio engine's DSP chain.
// Windows Audio Engine capture (16-bit stereo @ 48 kHz) →
//   channel downmix → resample to 16 kHz → high-pass → spectral noise gate →
//   VAD → speech classification → speech enhancement/AGC → 20 ms Int16 frames.
'use strict';

const dsp = require('./dsp-utils');
const { NoiseSuppressor } = require('./noise-suppressor');

// --- VAD ----------------------------------------------------------------
// Streaming energy-based voice-activity detector with smoothed level,
// attack threshold and a hangover so phrase end isn't clipped.
class VAD {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.frameMs = options.frameMs || 20;
    this.frameLen = Math.round((this.sampleRate * this.frameMs) / 1000);
    this.onsetThreshold = options.threshold ?? 0.015;      // RMS needed to start speech
    this.offsetThreshold = (options.offsetThreshold ?? 0.010); // RMS below which speech considered done
    this.attackFrames = options.attackFrames || 2;          // consecutive frames above onset
    this.hangoverFrames = options.hangoverFrames || 6;      // frames of grace after offset
    this.holdFrames = options.holdFrames || 2;              // after onset, hold speech

    this.level = 0;        // smoothed RMS level
    this.above = 0;        // consecutive frames above onset threshold
    this.hang = 0;         // hangover counter
    this.hold = 0;
    this.speaking = false;
  }

  process(frame) {
    const rms = dsp.rms(frame);
    // Smooth level (fast attack, slower release) — good for both VAD and meters.
    const alpha = rms > this.level ? 0.6 : 0.25;
    this.level += (rms - this.level) * alpha;

    const above = this.level >= this.onsetThreshold;
    if (above) {
      this.above++;
      this.hang = this.hangoverFrames;
    } else {
      this.above = 0;
    }

    if (this.speaking) {
      // Stay speaking through hangover & hold.
      if (this.hang > 0) {
        this.hang--;
        if (this.level < this.offsetThreshold) this.hang = 0; // long enough silence ends it
      } else {
        this.speaking = false;
      }
      if (this.hold > 0) this.hold--;
    } else if (this.above >= this.attackFrames) {
      this.speaking = true;
      this.hold = this.holdFrames;
    }

    // sanity: very loud but smooth block closing on silence resets hold
    if (!above && this.level < this.offsetThreshold && this.speaking) {
      this.hang = 0;
    }

    return { speaking: this.speaking, level: this.level };
  }

  reset() {
    this.level = 0; this.above = 0; this.hang = 0; this.hold = 0; this.speaking = false;
  }
}

// --- SpeechClassifier ---------------------------------------------------
// Heuristic frame classifier: silence / speech / noise (keyboard, music, tone).
class SpeechClassifier {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.speechFrames = 0;
    this.noiseFrames = 0;
    this.silenceFrames = 0;
    this.state = 'silence';
    this.confidence = 0;
  }

  classify(frame) {
    let energy = 0;
    let zcr = 0;
    let prev = frame[0];
    for (let i = 0; i < frame.length; i++) {
      energy += frame[i] * frame[i];
      if (i > 0 && ((prev >= 0 && frame[i] < 0) || (prev < 0 && frame[i] >= 0))) zcr++;
      prev = frame[i];
    }
    const rms = Math.sqrt(energy / frame.length);
    const zcrRate = zcr / frame.length;

    let label;
    if (rms < 0.012) {
      label = 'silence';
    } else if (zcrRate > 0.45) {
      label = 'noise'; // clicks / clatter
    } else if (zcrRate < 0.01 && rms > 0.4) {
      label = 'noise'; // continuous tone / music
    } else {
      label = 'speech';
    }

    // Smooth state transitions.
    const prevState = this.state;
    let confidence = this.confidence;
    if (label === prevState) {
      confidence = Math.min(1, confidence + 0.3);
    } else {
      confidence = Math.max(0, confidence - 0.4);
      if (confidence < 0.2) {
        this.state = label;
        confidence = 0.4;
      }
    }
    this.confidence = confidence;

    if (this.state === 'speech') this.speechFrames++;
    else if (this.state === 'noise') this.noiseFrames++;
    else this.silenceFrames++;

    return { state: this.state, confidence, rms, zcr: zcrRate };
  }

  reset() {
    this.speechFrames = 0; this.noiseFrames = 0; this.silenceFrames = 0;
    this.state = 'silence'; this.confidence = 0;
  }
}

// --- SpeechEnhancer -----------------------------------------------------
// Lightweight enhancement: lift the voice mid-band, tame the top end, and
// apply gentle soft-knee compression so loud sounds don't clip the STT.
class SpeechEnhancer {
  constructor({ sampleRate = 16000 } = {}) {
    this.sampleRate = sampleRate;
    this.midBoost = new dsp.Biquad('peaking', 1000, sampleRate, 0.707, 3);
    this.warmth = new dsp.Biquad('lowpass', 3800, sampleRate, 0.9);
    this.comp = { threshold: 0.5, ratio: 3, env: 0 };
  }

  processBlock(arr) {
    // EQ
    for (let i = 0; i < arr.length; i++) arr[i] = this.midBoost.process(arr[i]);
    for (let i = 0; i < arr.length; i++) arr[i] = this.warmth.process(arr[i]);
    // Soft-knee compressor
    for (let i = 0; i < arr.length; i++) {
      const x = Math.abs(arr[i]);
      this.comp.env += (x - this.comp.env) * (x > this.comp.env ? 0.2 : 0.6);
      let g = 1;
      if (this.comp.env > this.comp.threshold) {
        const over = this.comp.env - this.comp.threshold;
        g = 1 / (1 + over * this.comp.ratio);
      }
      arr[i] = arr[i] * (0.6 + 0.4 * (g));
      // soft clip
      const t = arr[i];
      if (t > 0.95) arr[i] = 0.95 + (t - 0.95) * 0.15;
      else if (t < -0.95) arr[i] = -0.95 + (t + 0.95) * 0.15;
    }
    return arr;
  }
}

// --- AudioProcessingPipeline --------------------------------------------
class AudioProcessingPipeline {
  constructor(options = {}) {
    this.inRate = options.inRate || 48000;
    this.channels = options.channels || 2;
    this.outRate = options.outRate || 16000;
    this.frameMs = options.frameMs || 20;
    this.frameLen = Math.round((this.outRate * this.frameMs) / 1000); // e.g. 320 @ 16k
    this.highPassHz = options.highPassHz ?? 80;
    this.vadThreshold = options.vadThreshold ?? 0.015;
    this.noiseGate = options.noiseGate !== false;
    this.metrics = options.metrics || null;

    this.label = options.label || 'audio';

    this.resampler = new dsp.StreamResampler(this.inRate, this.outRate);
    this.highPass = new dsp.Biquad('highpass', this.highPassHz, this.outRate, 0.707);
    this.suppressor = this.noiseGate ? new NoiseSuppressor({ sampleRate: this.outRate }) : null;
    this.enhancer = new SpeechEnhancer({ sampleRate: this.outRate });
    this.normalizer = new dsp.LevelNormalizer({ targetRms: options.targetRms ?? 0.14 });
    this.vad = new VAD({ sampleRate: this.outRate, frameMs: this.frameMs, threshold: this.vadThreshold });
    this.classifier = new SpeechClassifier({ sampleRate: this.outRate });

    this.pend = []; // cleaned 16k samples awaiting framing (one-shot per feed)
    this.frameCount = 0;
  }

  feed(inputBuf) {
    if (this.metrics) this.metrics.onRawFrame(inputBuf.byteLength || inputBuf.length, this.inRate);

    // Downmix to mono float.
    const mono = dsp.interleavedInt16ToMonoF64(inputBuf, this.channels);
    // Resample to output rate.
    const resampled = this.resampler.push(mono);
    if (resampled.length === 0) return [];

    // High-pass -> remove subsonic rumble (samples handed to each stage exactly once).
    const hp = new Float64Array(resampled.length);
    for (let i = 0; i < resampled.length; i++) {
      hp[i] = this.highPass.process(resampled[i]);
    }
    let cleaned = hp;
    if (this.suppressor) {
      // Suppressor accumulates internally and returns only NEW output samples.
      cleaned = this.suppressor.process(hp);
    }

    // Continue framing the cleaned stream.
    for (let i = 0; i < cleaned.length; i++) this.pend.push(cleaned[i]);
    const frames = [];
    while (this.pend.length >= this.frameLen) {
      const frame = Float64Array.from(this.pend.slice(0, this.frameLen));
      this.pend = this.pend.slice(this.frameLen);
      frames.push(this.frameAudio(frame));
      this.frameCount++;
    }
    return frames;
  }

  frameAudio(frame) {
    const vad = this.vad.process(frame);
    const cls = this.classifier.classify(frame);
    const enhanced = this.enhancer.processBlock(Float64Array.from(frame));
    const gained = this.normalizer.processBlock(enhanced);

    const isSpeech = vad.speaking && cls.state !== 'noise';
    if (this.metrics) this.metrics.trackVad(isSpeech);

    const pcm = dsp.monoF64ToInt16Buffer(gained);

    return {
      pcm,                       // Buffer<int16> frameLen samples @ outRate
      sampleRate: this.outRate,
      level: vad.level,          // smoothed RMS (0..1)
      vad: vad.speaking,
      vadLevel: vad.level,
      speech: isSpeech,          // combned VAD + classifier
      classifier: cls.state,
      classifierConfidence: cls.confidence,
    };
  }

  flush() {
    // Emit any leftover partial frame (stream end).
    const frames = [];
    while (this.pend.length >= this.frameLen) {
      const frame = Float64Array.from(this.pend.slice(0, this.frameLen));
      this.pend = this.pend.slice(this.frameLen);
      frames.push(this.frameAudio(frame));
      this.frameCount++;
    }
    return frames;
  }

  reset() {
    this.vad.reset();
    this.classifier.reset();
    this.pend = [];
    this.frameCount = 0;
  }
}

module.exports = { AudioProcessingPipeline, VAD, SpeechClassifier, SpeechEnhancer };