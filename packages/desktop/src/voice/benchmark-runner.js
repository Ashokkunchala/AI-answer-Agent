// benchmark-runner.js — offline benchmark harness.
//
// Drives a prerecorded WAV through the *exact same* DSP pipeline, VAD
// state machine and (if configured) the real Deepgram + worker-AI stack,
// tracing latency with the same LatencyTracker used live. Results let us
// measure the real budget under controlled conditions.
'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const { AudioProcessingPipeline } = require('../audio/audio-processing-pipeline');
const { VoiceActivityDetector } = require('./voice-activity-detector');
const { LatencyTracker, nsToMs } = require('./latency-tracker');
const { detectQuestion } = require('./question-detector');

// Parse a RIFF/WAVE file into { channels, sampleRate, bitsPerSample, pcm }.
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF/WAV file');
  }
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  let offset = 12;
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLen = size;
      break;
    }
    offset = body + size + (size & 1);
  }
  if (dataStart < 0) throw new Error('No data chunk in WAV');
  return {
    channels,
    sampleRate,
    bitsPerSample: bits,
    pcm: buf.subarray(dataStart, dataStart + dataLen),
  };
}

const FRAME_MS = 20;

class BenchmarkRunner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.stt = options.stt || null;          // StreamingSTT (optional)
    this.ai = options.ai || null;            // AiClient (optional)
    this.outRate = options.outRate || 16000;
    this.keywords = options.keywords || undefined;
    this.chunkMs = options.chunkMs || 100;
    this.sampleRate = options.sampleRate || 16000;

    this.latency = new LatencyTracker({ maxHistory: 512 });
    this.vad = new VoiceActivityDetector({
      pauseResumeMs: options.pauseResumeMs ?? 300,
      speechEndMs: options.speechEndMs ?? 1000,
      minSpeechMs: options.minSpeechMs ?? 200,
    });

    this.results = null;
    this.pipelineMetrics = {
      frames: 0,
      speechFrames: 0,
      speakerFrames: 0,
      combinedSpeechFrames: 0,
    };
  }

  _now() {
    return process.hrtime.bigint();
  }

  async runWav(filePath, opts = {}) {
    const speed = opts.speed || 1;
    const askAI = opts.askAI !== undefined ? opts.askAI : true;

    const raw = fs.readFileSync(filePath);
    const wav = parseWav(raw);
    if (wav.bitsPerSample !== 16) throw new Error('Only 16-bit WAV supported');

    const pipeline = new AudioProcessingPipeline({
      inRate: wav.sampleRate,
      channels: wav.channels,
      outRate: this.outRate,
      frameMs: FRAME_MS,
      vadThreshold: 0.01,
      noiseGate: true,
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const chunkBytes = Math.max(640, Math.round((wav.sampleRate * wav.channels * 2 * this.chunkMs) / 1000));
    const sttResults = [];
    const aiResults = [];

    // Track each utterance with our real VAD + latency tracker.
    let trackUtterance = null;

    this.vad.onStateChange = () => { /* internal */ };
    this.vad.onSpeechStart = () => {
      trackUtterance = this.latency.begin('bench-utterance');
      this.latency.mark('vadSpeechStart', this._now());
      this.emit('speech-start', {});
    };
    this.vad.onSpeechEnd = ({ durationMs }) => {
      if (trackUtterance) this.latency.mark('vadSpeechEnd', this._now());
      if (this.stt && this.stt.isConnected) this.stt.finalizeCurrent();
      this.emit('speech-end', { durationMs });
    };

    if (this.stt) {
      this.stt.on('partial', () => { /* partial ignored in bench */ });
      this.stt.on('final', (f) => {
        if (trackUtterance) {
          this.latency.mark('sttFinal', this._now());
          this.latency.mark('questionDetected', this._now());
        }
        const q = detectQuestion(f.transcript);
        sttResults.push({ text: f.transcript, confidence: f.confidence, isQuestion: q.isQuestion, qKind: q.kind, utteranceId: f.utteranceId });
        this.emit('stt-final', f);
        if (askAI && this.ai && q.isQuestion && trackUtterance) {
          this.latency.mark('aiRequestStart', this._now());
          this.#benchAI(f.transcript, aiResults, trackUtterance);
        }
      });
    }

    const t0 = process.hrtime.bigint();
    let nowNs = t0;
    const stepNs = BigInt(FRAME_MS) * 1000000n;

    for (let off = 0; off < wav.pcm.length; off += chunkBytes) {
      const chunk = wav.pcm.subarray(off, off + chunkBytes);
      const frames = pipeline.feed(Buffer.from(chunk));
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        nowNs += stepNs;
        this.pipelineMetrics.frames++;
        if (frame.vad) this.pipelineMetrics.speechFrames++;
        if (frame.speech) this.pipelineMetrics.combinedSpeechFrames++;

        frame.nowNs = nowNs;
        this.vad.process(frame);

        if (this.stt && this.stt.isConnected && (frame.speech || (this.vad.getState() !== 'IDLE' && this.vad.getState() !== 'SPEECH_END'))) {
          this.stt.sendAudio(frame.pcm);
        }
      }
      // Pace feeding so the live STT sees realistic timing.
      const paceMs = (chunkBytes / (wav.sampleRate * wav.channels * 2)) * 1000;
      if (speed >= 1) await sleep(paceMs / Math.max(1, speed));
      else await sleep((paceMs / Math.max(1, speed)) / 4);
      this.vad.tick(nowNs + BigInt(Math.round(paceMs * 0.5)) * 1000000n);
    }

    // Wind down: push remaining partial frame + let VAD end speech.
    const tail = pipeline.flush();
    for (const frame of tail) {
      nowNs += stepNs;
      frame.nowNs = nowNs;
      this.vad.process(frame);
      if (this.stt && this.stt.isConnected) this.stt.sendAudio(frame.pcm);
    }
    for (let i = 0; i < 25; i++) {
      nowNs += stepNs;
      this.vad.tick(nowNs);
      await sleep(20);
    }

    // Wait briefly for late STT finals to land (if connected).
    if (this.stt && this.stt.isConnected) {
      await sleep(1500);
    }

    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    this.results = {
      wav: {
        path: filePath,
        sampleRate: wav.sampleRate,
        channels: wav.channels,
        durationMs: Math.round((wav.pcm.length / (wav.sampleRate * wav.channels * 2)) * 1000),
        processedMs: Math.round(dt),
      },
      pipeline: this.pipelineMetrics,
      stt: {
        connected: !!(this.stt && this.stt.isConnected),
        provider: this.stt ? 'deepgram' : 'none',
        finals: sttResults,
        finalCount: sttResults.length,
      },
      ai: {
        enabled: !!this.ai,
        queries: aiResults,
        queryCount: aiResults.length,
      },
      latency: {
        stats: this.latency.stats(),
        perUtterance: this.latency.history.map((r) => ({ id: r.id, ms: r.ms })),
      },
      target: { budget1500ms: 1500 },
    };
    this.emit('done', this.results);
    return this.results;
  }

  async #benchAI(transcript, into, track) {
    if (!this.ai) return;
    const firstTokenMs = await new Promise((resolve) => {
      let done = false;
      const ok = (ms) => { if (!done) { done = true; resolve(ms); } };
      this.ai.once('first-token', () => ok(0));
      this.ai.once('error', () => ok(-1));
      this.ai.streamAnswer({ transcript, taskType: 'benchmark' }).then(() => {
        if (track) {
          this.latency.mark('aiCompleted', this._now());
          this.latency.complete({});
        }
        resolve(-2);
      }).catch(() => { resolve(-2); });
    });
    into.push({ transcript, firstTokenMs });
  }
}

module.exports = { BenchmarkRunner, parseWav };