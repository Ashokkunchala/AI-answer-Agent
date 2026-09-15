// audio-metrics.js — captures, durations & latency counters for the WASAPI
// audio engine. Mirrors the concept of Windows Audio Engine metrics,
// exposing everything the renderer needs for badges/debug panels.
'use strict';

class AudioMetrics {
  constructor() {
    this.reset();
  }

  reset() {
    this.captureStart = 0;
    this.firstAudioFrame = 0;
    this.captureEnd = 0;
    this.framesReceived = 0;
    this.framesDropped = 0;
    this.pcmSeconds = 0;
    this.framesSent = 0;
    this.lastFrameAt = 0;
    this.lastFrameSizeMs = 0;
    this.sampleRate = 16000;
    this.inSampleRate = 48000;
    this.speechStart = 0;
    this.speechEnd = 0;
    this.speechSamples = 0;
    this.noiseGateHits = 0;
    this.errors = [];
  }

  beginCapture() {
    this.reset();
    this.captureStart = Date.now();
  }

  onRawFrame(bytes, inRate) {
    this.framesReceived++;
    if (!this.firstAudioFrame) this.firstAudioFrame = Date.now();

    const frameMs = bytes / (2 * 2 * (inRate / 1000)); // int16 * 2ch at input rate
    this.pcmSeconds += frameMs / 1000;
    this.lastFrameSizeMs = round(frameMs);
    this.inSampleRate = inRate;
    this.lastFrameAt = Date.now();
  }

  onFrameSent(level) {
    this.framesSent++;
    if (level !== null) {
      // Track the first speech-likely moment using level > 0 (actual VAD handled by pipeline).
    }
  }

  trackVad(isSpeech, now) {
    const t = now || Date.now();
    if (isSpeech) {
      if (!this.speechStart) this.speechStart = t;
      this.speechSamples++;
    } else if (this.speechStart && !this.speechEnd) {
      this.speechEnd = t;
    }
  }

  trackNoiseGate() {
    this.noiseGateHits++;
  }

  endCapture() {
    this.captureEnd = Date.now();
  }

  snapshot() {
    return {
      captureStart: this.captureStart,
      captureEnd: this.captureEnd,
      framesReceived: this.framesReceived,
      framesDropped: this.framesDropped,
      framesSent: this.framesSent,
      pcmSeconds: round(this.pcmSeconds),
      firstAudioFrame: this.firstAudioFrame,
      lastFrameAt: this.lastFrameAt,
      lastFrameSizeMs: this.lastFrameSizeMs,
      sampleRate: this.sampleRate,
      inSampleRate: this.inSampleRate,
      speechStart: this.speechStart,
      speechEnd: this.speechEnd || 0,
      speechSamples: this.speechSamples,
      noiseGateHits: this.noiseGateHits,
      errors: this.errors.slice(-5),
      captureDurationMs: this.captureStart ? Date.now() - this.captureStart : 0,
    };
  }
}

function round(v, p = 2) {
  return Math.round(v * Math.pow(10, p)) / Math.pow(10, p);
}

module.exports = { AudioMetrics };