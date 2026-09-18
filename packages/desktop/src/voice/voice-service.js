// voice-service.js — the voice pipeline orchestrator (main process).
//
// Owns: audio capture (WasapiCapture) → DSP frames → VAD state machine →
// persistent streaming STT (Deepgram Flux) → Transcript/Turn/Conversation
// managers → question gate → streaming AI answer, plus latency
// instrumentation, session lifecycle, recovery and IPC-friendly event dispatch.
//
// Turn flow (Flux, adaptive — no fixed setTimeout as the primary mechanism):
//   stt events -> TurnManager (turn lifecycle) -> transcript finalization ->
//   question gate -> AiClient stream. EagerEndOfTurn may pre-start the answer;
//   TurnResumed/StartOfTurn interruptions cancel the stale request.
//
// Keep inside a single page/panel: the same service instance drives capture
// for the interview session. This module never imports electron — main.js
// wires it to IPC, so it stays testable in plain Node.
'use strict';

const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { WasapiCapture, CAPTURE_STATE } = require('../audio/wasapi-capture');
const { AudioDeviceManager } = require('../audio/audio-device-manager');
const { AudioSourceManager, SRC_KIND, SRC_STATE } = require('../audio/audio-source-manager');
const { StreamingSTT } = require('./streaming-stt');
const { AiClient } = require('./ai-client');
const { VoiceActivityDetector, State } = require('./voice-activity-detector');
const { LatencyTracker } = require('./latency-tracker');
const { detectQuestion } = require('./question-detector');
const { TranscriptManager } = require('./transcript-manager');
const { TurnManager } = require('./turn-manager');
const { ConversationManager } = require('./conversation-manager');

const PHASE = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  WARMING_UP: 'WARMING_UP',
  READY: 'READY',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  ERROR: 'ERROR',
  SESSION_ENDED: 'SESSION_ENDED',
};

// Max capture restart attempts before giving up (error recovery).
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = 1200;

class VoiceService extends EventEmitter {
  constructor(options = {}) {
    super();
    const cfg = options.config || {};
    this.cfg = cfg;
    this.deps = options.deps || {};
    this.log = cfg.log ? (typeof cfg.log === 'function' ? cfg.log : (...a) => { }) : ((..._a) => { });

    // Emit hook set by main.js for renderer delivery.
    this.emitToRenderer = options.emitToRenderer || (() => { });

    this.phase = PHASE.IDLE;
    this.listeningEnabled = true;
    this.utteranceCount = 0;
    this.questionCount = 0;
    this.answerCount = 0;
    this.lastTranscript = '';
    this.lastQuestion = '';
    this.errors = [];
    this._probedModel = false;

    // One session id for the whole run; shared with the worker's /api/answer.
    this.sessionId = cfg.sessionId || randomUUID();

    this.deviceManager = this.deps.deviceManager || new AudioDeviceManager({});
    this.sourceManager = new AudioSourceManager({ deviceManager: this.deviceManager });
    this.capture = this.deps.capture || new WasapiCapture({
      sampleRate: cfg.sampleRate || 16000,
      vadThreshold: cfg.vadThreshold ?? 0.015,
      noiseGate: cfg.noiseGate !== false,
      log: this.log,
    });
    this.stt = this.deps.stt || new StreamingSTT({
      apiKey: cfg.deepgramApiKey || '',
      sampleRate: cfg.sampleRate || 16000,
      model: cfg.sttModel,                // 'flux-general-en' default
      eagerEotThreshold: cfg.eagerEotThreshold ?? 0.5,
      eotThreshold: cfg.eotThreshold ?? 0.5,
      eotTimeoutMs: cfg.eotTimeoutMs ?? 1500,
      log: this.log,
    });
this.ai = this.deps.ai || new AiClient({
      workerUrl: cfg.workerUrl || '',
      defaultWorkerUrl: cfg.defaultWorkerUrl || '',
      apiKey: cfg.apiKey || '',
      resume: cfg.resume,
      jobDesc: cfg.jobDesc,
      targetName: cfg.targetName,
      participants: cfg.participants,
      answerEndpoint: !!cfg.voiceAnswerEndpoint,
      model: (cfg.model && cfg.model !== 'auto') ? cfg.model : 'auto',   // auto lets the worker route; we learn the working model from the stream
      modelCacheFile: cfg.modelCacheFile,   // persist the learned good model across restarts (optional)
      log: this.log,
    });

    if (this.deps.latency) this.latency = this.deps.latency;
    else {
      this.latency = new LatencyTracker({ maxHistory: cfg.latencyHistory || 60 });
    }

    this.vad = new VoiceActivityDetector({
      pauseResumeMs: cfg.pauseResumeMs ?? 300,
      speechEndMs: cfg.speechEndMs ?? 1000,
      minSpeechMs: cfg.minSpeechMs ?? 200,
      finalizeTimeoutMs: cfg.finalizeTimeoutMs ?? 1500,
      onSpeechStart: (ns) => this.#onSpeechStart(ns),
      onSpeechEnd: ({ durationMs, nowNs, forced }) => this.#onSpeechEnd(durationMs, nowNs),
    });

    // Context managers (Transcript / Turn / Conversation).
    this.transcript = new TranscriptManager({ log: this.log });
    this.turnMan = new TurnManager({
      sessionId: this.sessionId,
      eagerEnabled: cfg.eagerAnswer !== false,
      eagerEotThreshold: cfg.eagerEotThreshold ?? 0.5,
      endGraceMs: cfg.endGraceMs ?? 800,
      log: this.log,
    });
    this.conversation = new ConversationManager({ sessionId: this.sessionId });

    this._gateOpen = false;
    this._ready = false;
    this._lastUtteranceId = '';
    this._sttConnectedEver = false;
    this._restartAttempts = 0;
    this._restartTimer = null;
    this._vadTimer = null;
    this._audioHealthTimer = null;
    this._lastDeviceChange = null;
    this.audioFramesFed = 0;
    this.audioFramesRejected = 0;
    this.lastAudioFrameAt = 0;
    this.lastAudioLevel = 0;
    this._stopping = false;
    this._sessionActive = false;

    // Active AI request bookkeeping (used for interruption + stale-answer drop).
    this._ask = null;                   // { turnId, question, status, asked, active, wasCancelled }
    this.maxFirstPartials = 500;        // bound on the per-turn partial marker set
    this._firstPartialPerTurn = new Set();
  }

  // ---------------------------------------------------------------- warmup
  async init() {
    this.deviceManager.onDevicesChanged = (change) => this.#onDevicesChanged(change);
    this.deviceManager.onSnapshot = (snap) => {
      this.emitToRenderer('voice:devices', snap);
    };
    await this.deviceManager.start();
    await this.sourceManager.enumerate(true);
    // Pick up the config default source if set, otherwise system output.
    const preferred = this.cfg.audioSourceId || this.cfg.audioSourceName;
    if (preferred) {
      const found = this.sourceManager.sources.find((s) => s.id === preferred);
      if (!found && this.cfg.audioSourceName) {
        const byName = this.sourceManager.sources.find((s) =>
          String(s.name || '').toLowerCase().includes(String(this.cfg.audioSourceName).toLowerCase()));
        if (byName) this.sourceManager.select(byName.id);
      } else if (found) {
        this.sourceManager.select(found.id);
      }
    }
    this.phase = PHASE.IDLE;
    this.#broadcastState();
    return this.getDiagnostics();
  }

  async start() {
    if (this._sessionActive) return { ok: true };
    this._sessionActive = true;
    this._stopping = false;
    this.transcript.reset();
    this.turnMan.reset();
    this._ask = null;
    this._firstPartialPerTurn = new Set();
    this.audioFramesFed = 0;
    this.audioFramesRejected = 0;
    this.lastAudioFrameAt = 0;
    this.lastAudioLevel = 0;
    this.phase = PHASE.STARTING;
    this.#broadcastState();

    // 1) Capture (real WASAPI).
    const src = this.sourceManager.selected || { kind: SRC_KIND.SYSTEM, name: 'System Output (Default device)' };
    this.#setSourceState(SRC_STATE.CONNECTING);
    const captureResult = this.#startCapture(src);
    if (!captureResult.ok) {
      this.phase = PHASE.ERROR;
      this.#reportError({ type: 'capture', code: 'CAPTURE_START_FAILED', userMessage: 'Could not start audio capture: ' + captureResult.error });
      // Keep initializing STT + AI warmup below: recovery is still possible
      // once the capture source becomes healthy, but signal the failure now.
    }

    // 1b) Learn/refresh the working AI model early so the first real question
    // after launch skips the router's failing-model attempt (~1s) entirely.
    this.#probeModel();

    // 2) Persistent Deepgram Flux STT session.
    this.stt.startSession();
    this.stt.on('partial', (p) => this.#onSttPartial(p));
    this.stt.on('turn-start', (p) => this.#onSttTurnStart(p));
    this.stt.on('eager-end', (p) => this.#onSttEager(p));
    this.stt.on('turn-resumed', (p) => this.#onSttTurnResumed(p));
    this.stt.on('final', (f) => this.#onSttFinal(f));
    this.stt.on('connected', () => { this._sttConnectedEver = true; this.#evaluateReady(); });
    this.stt.on('disconnected', () => this.#evaluateReady());
    this.stt.on('error', (err) => this.#onSttError(err));

    // Turn lifecycle (single source of truth for starts/ends/interruptions).
    // Re-startable: drop any listeners from a previous session first.
    this.turnMan.removeAllListeners();
    this.turnMan.on('turn-start', (ev) => this.#onTurnStart(ev));
    this.turnMan.on('turn-interrupted', (ev) => this.#onTurnInterrupted(ev));
    this.turnMan.on('partial', (ev) => this.#onTurnPartial(ev));
    this.turnMan.on('eager', (ev) => this.#onTurnEager(ev));
    this.turnMan.on('turn-resumed', (ev) => this.#onTurnResumed(ev));
    this.turnMan.on('turn-complete', (ev) => this.#onTurnComplete(ev));

    // 3) AI warmup (reachability ping — no tokens spent). Only mark warming up
    // if capture is live; otherwise stay in the ERROR phase reported above.
    if (captureResult.ok) {
      this.phase = PHASE.WARMING_UP;
      this.#broadcastState();
    }
    this.ai.warmup().then((w) => {
      this.#evaluateReady();
      if (!w.ok) this.#reportError({ type: 'ai', code: 'AI_UNREACHABLE', userMessage: 'AI backend is not reachable. Answers will be unavailable.' });
    });

    // 4) VAD ticking.
    this._vadTimer = setInterval(() => this.vad.tick(), 30);
    if (this._vadTimer.unref) this._vadTimer.unref();

    // Detect a capture device that reports started but never delivers data.
    this._audioHealthTimer = setTimeout(() => {
      this._audioHealthTimer = null;
      if (!this._sessionActive) return;
      const snap = this.capture.snapshot();
      if (snap.state === CAPTURE_STATE.CAPTURING && snap.chunksReceived === 0) {
        this.#reportError({
          type: 'capture',
          code: 'AUDIO_NO_DATA',
          userMessage: 'Audio capture started, but Windows has delivered no audio data. Check the selected audio source and Windows output/microphone device.'
        });
        this.#broadcastState();
      }
    }, 2500);
    if (this._audioHealthTimer.unref) this._audioHealthTimer.unref();

    return { ok: captureResult.ok, error: captureResult.ok ? undefined : captureResult.error };
  }

  #startCapture(src) {
    this.capture.removeAllListeners();
    this.capture.on('frame', (f) => this.#onFrame(f));
    this.capture.on('error', (err) => this.#onCaptureError(err));
    this.capture.on('process-exit', (pid) => this.#onProcessExit(pid));
    this.capture.on('state', (s) => {
      if (s === CAPTURE_STATE.ERROR) this.#setSourceState(SRC_STATE.ERROR);
      this.#broadcastState();
    });
    return this.capture.start(src.kind === 'process' ? { ...src, includeTree: true } : src);
  }

  // ------------------------------------------------------------- session
  async stop() {
    this._stopping = true;
    this._sessionActive = false;
    this.phase = PHASE.SESSION_ENDED;
    if (this._vadTimer) { clearInterval(this._vadTimer); this._vadTimer = null; }
    if (this._audioHealthTimer) { clearTimeout(this._audioHealthTimer); this._audioHealthTimer = null; }
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    try { this.ai.cancel(); } catch (_) { /* */ }
    this.stt.stopSession();
    this.stt.removeAllListeners();
    this.capture.stop();
    this.capture.removeAllListeners();
    this.sourceManager.setState(SRC_STATE.DISCONNECTED);
    // Clear per-session state so a later start() begins clean (no stale gate,
    // restart budget, STT/AI readiness or in-flight ask leaking across runs).
    this._ready = false;
    this._sttConnectedEver = false;
    this._restartAttempts = 0;
    this._gateOpen = false;
    this._ask = null;
    this._firstPartialPerTurn = new Set();
    this.phase = PHASE.SESSION_ENDED;
    this.#broadcastState();
  }

  // Pause/resume feeding live audio to STT (keep capture running warm).
  setListening(enabled) {
    const wasPaused = !this.listeningEnabled;
    this.listeningEnabled = enabled;
    if (enabled && !wasPaused) return { ok: true };
    if (enabled) {
      this.phase = this.phase === PHASE.PROCESSING ? PHASE.PROCESSING : PHASE.READY;
      this.#evaluateReady();
    } else {
      this._gateOpen = false;
    }
    this.#broadcastState();
    return { ok: true };
  }

  // ------------------------------------------------------------- sources
  async listSources() {
    const sources = await this.sourceManager.enumerate(false);
    return sources;
  }

  async selectSource(id) {
    const res = this.sourceManager.select(id);
    if (!res.ok) return res;
    const src = res.source;
    this.#setSourceState(SRC_STATE.CONNECTING);

    // Mic sources need renderer getUserMedia streaming; other sources just
    // restart the native loopback capture.
    if (src.kind === SRC_KIND.MIC) {
      this.emitToRenderer('voice:mic-request', {
        enable: true,
        deviceId: src.deviceId,
        deviceName: src.device && src.device.name ? src.device.name : src.name,
      });
    } else {
      this.emitToRenderer('voice:mic-request', { enable: false });
    }
    const captureRes = this.capture.switchSource(src.kind === 'process' ? { ...src, includeTree: true } : src);
    if (!captureRes.ok) {
      await this.#tryRecover(captureRes.error);
      return captureRes;
    }
    this._restartAttempts = 0;
    this.#setSourceState(SRC_STATE.CONNECTED);
    this.#broadcastState();
    return { ok: true, source: src };
  }

  #setSourceState(s) {
    this.sourceManager.setState(s);
    this.emitToRenderer('voice:sources', this.sourceManager.snapshot());
  }

  // Push microphone PCM frames (48k mono int16) from the renderer.
  pushMicFrame(buf) {
    this.capture.pushMicPcm(buf);
  }

  reportUiLatency(ms) {
    this.latencyUiMs = ms;
  }

  // --------------------------------------------------------------- frames
  #onFrame(frame) {
    if (!this._sessionActive) return;

    this.vad.process(frame);

    // Voice-gated STT feed: once speech opens the gate we keep feeding
    // until the utterance is finalized (post-roll), so end-of-phrase
    // acoustics never get cut. sendAudio buffers internally while the
    // socket is (re)connecting so the utterance's opening words survive.
    if ((this._gateOpen || frame.speech) && this.listeningEnabled) {
      const accepted = this.stt.sendAudio(frame.pcm);
      if (accepted) this.audioFramesFed++;
      else this.audioFramesRejected++;
      this.lastAudioFrameAt = Date.now();
      this.lastAudioLevel = Number.isFinite(frame.level) ? frame.level : 0;
      this._gateOpen = true;
    }

    // Forward level + waveform to the UI (transferable buffer, cheap).
    this.emitToRenderer('voice:frame', {
      level: frame.level,
      vad: frame.vad,
      speech: frame.speech,
      classifier: frame.classifier,
      classifierConfidence: frame.classifierConfidence,
      sampleRate: frame.sampleRate,
      pcm: frame.pcm,
    });
  }

  // ---------------------------------------------------------------- VAD
  #onSpeechStart(_ns) {
    this.utteranceCount++;
    this.latency.begin('utterance');
    this.latency.mark('vadSpeechStart', _ns);
    this.turnMan.onLocalSpeechStart();
    this.#broadcastState();
  }

  #onSpeechEnd(durationMs, nowNs) {
    this.latency.mark('vadSpeechEnd');
    this.vad.finalizing();
    this.latency.mark('sttUtteranceFlush');
    // Flux uses model-integrated end-of-turn; send the trailing audio so the
    // last phrase fully reaches the provider before EndOfTurn is judged.
    this.stt.flushSend();
    // Let the turn manager watch for the Flux EndOfTurn (grace fallback).
    this.turnMan.onLocalSpeechEnd();
    this.phase = PHASE.LISTENING;
    this.#broadcastState();
  }

  // ----------------------------------------------------------- interrupts
  #cancelActiveAsk() {
    if (this._ask && this._ask.active) {
      this._ask.wasCancelled = true;
      this._ask.active = false;
      try { this.ai.cancel(); } catch (_) { /* */ }
      if (this.phase === PHASE.PROCESSING) {
        this.phase = this.#readyPhase();
        this.#broadcastState();
      }
    }
  }

  // A new flux turn started (new StartOfTurn) — the interviewer moved on.
  #onTurnStart(_ev) {
    // Note: turn bookkeeping is done inside TurnManager; here we only care
    // that a fresh turn supersedes any in-flight answer.
    this.#cancelActiveAsk();
  }

  #onTurnInterrupted(ev) {
    this.log('[voice] turn interrupted', ev && ev.turnId);
    this.#cancelActiveAsk();
  }

  // ---------------------------------------------------------------- STT
  #onSttTurnStart(p) {
    if (!p) return;
    const cur = this.turnMan.current();
    if (!(cur && cur.turnIndex === p.turnIndex)) {
      this.#cancelActiveAsk();
    }
    this.turnMan.onFlux({
      kind: 'start',
      turnIndex: p.turnIndex,
      sequenceId: p.sequenceId,
      transcript: p.transcript || '',
    });
  }

  #onSttPartial(p) {
    if (!p || p.transcript == null) return;
    this.turnMan.onFlux({
      kind: p.event === 'start' ? 'start' : 'update',
      turnIndex: p.turnIndex,
      sequenceId: p.sequenceId,
      transcript: p.transcript,
    });
  }

  #onSttEager(p) {
    if (!p) return;
    this.turnMan.onFlux({
      kind: 'eager-end',
      turnIndex: p.turnIndex,
      sequenceId: p.sequenceId,
      transcript: p.transcript || '',
      endOfTurnConfidence: p.endOfTurnConfidence,
    });
  }

  #onSttTurnResumed(p) {
    if (!p) return;
    this.turnMan.onFlux({
      kind: 'turn-resumed',
      turnIndex: p.turnIndex,
      sequenceId: p.sequenceId,
      transcript: p.transcript || '',
    });
  }

  #onSttFinal(f) {
    if (!f || !f.transcript) return;
    this.turnMan.onFlux({
      kind: 'final',
      turnIndex: f.turnIndex,
      sequenceId: f.sequenceId,
      transcript: f.transcript,
      trigger: f.trigger,
      endOfTurnConfidence: f.endOfTurnConfidence,
    });
  }

  #onTurnPartial(ev) {
    if (!ev || !ev.transcript) return;
    // Defensive latency run if the provider finalizes without our VAD onset.
    if (!this.latency.tracking) this.latency.begin('utterance');
    // First non-empty partial of this turn = firstPartial marker.
    if (ev.turnIndex != null && ev.transcript && !this._firstPartialPerTurn.has(ev.turnIndex)) {
      this.#trackFirstPartial(ev.turnIndex);
      this.latency.mark('firstPartial');
    }
    this.transcript.beginTurn(ev.turnIndex, ev.transcript) ||
      this.transcript.updateTurn(ev.turnIndex, ev.transcript);
    this.emitToRenderer('voice:partial-transcript', {
      transcript: ev.transcript,
      confidence: null,
      turnId: ev.turnId,
      turnIndex: ev.turnIndex,
    });
    this.lastTranscript = ev.transcript;
    // whis-ai-style early answer: once the partial already reads as a complete
    // question, start generation NOW instead of waiting for Flux's EndOfTurn
    // (which typically lands a second+ after the speaker stops). TurnResumed or
    // a corrected final reconciles if the speaker actually kept going.
    if (this.cfg.earlyAnswerOnPartial !== false && ev.turnId != null) {
      this.#maybeStartFromPartial(ev.transcript, ev.turnId);
    }
  }

  // Start answering mid-speech from a partial transcript. This is the lever
  // that gets answer latency under the whis-ai <2s budget: the first confident
  // partial usually arrives while the interviewer is still finishing, so the
  // AI first token can land right around the end of their speech.
  #maybeStartFromPartial(transcript, turnId) {
    const ask = this._ask;
    if (ask && ask.turnId === turnId && ask.asked && !ask.wasCancelled) return; // already answered this turn
    const minLen = this.cfg.partialMinLength ?? 16;
    const threshold = this.cfg.partialQuestionThreshold ?? 0.55;
    if ((transcript || '').length < minLen) return;
    const q = detectQuestion(transcript);
    if (!q.isQuestion || q.confidence < threshold) return;
    if (this._ask && this._ask.asked && !this._ask.wasCancelled) return; // safety — no double answers
    this.log('[voice] question recognized on partial — starting answer early:', transcript);
    this.#tryAskQuestion(transcript, { turnId, status: 'eager', viaEager: false, viaPartial: true });
  }

  // Remember a turn's first partial marker, pruning the oldest entries once
  // the set exceeds its bound so a long session's memory stays flat.
  #trackFirstPartial(turnIndex) {
    this._firstPartialPerTurn.add(turnIndex);
    if (this._firstPartialPerTurn.size <= this.maxFirstPartials) return;
    const excess = this._firstPartialPerTurn.size - this.maxFirstPartials;
    const it = this._firstPartialPerTurn.values();
    for (let i = 0; i < excess; i++) {
      this._firstPartialPerTurn.delete(it.next().value);
    }
  }

  #onTurnEager(ev) {
    if (!ev || !ev.transcript) return;
    if (this.cfg.eagerAnswer === false) return;
    // Pre-start generation on the eager draft if it looks like a question and
    // we haven't already answered this turn.
    this.transcript.beginTurn(ev.turnIndex, ev.transcript) ||
      this.transcript.updateTurn(ev.turnIndex, ev.transcript);
    this.#tryAskQuestion(ev.transcript, { turnId: ev.turnId, status: ev.status, viaEager: true });
  }

  #onTurnResumed(ev) {
    if (!ev) return;
    // Speaker resumed this turn → any eager-prefetched answer is stale.
    this.#cancelActiveAsk();
    this.phase = PHASE.LISTENING;
    this.#broadcastState();
  }

  #onTurnComplete(ev) {
    if (!ev || !ev.transcript) { this.#broadcastState(); return; }
    this.latency.mark('sttFinal');
    const fin = this.transcript.finalizeTurn(ev.turnIndex, ev.transcript, { trigger: ev.trigger });
    this.lastTranscript = ev.transcript;
    this.emitToRenderer('voice:final-transcript', {
      transcript: ev.transcript,
      confidence: null,
      utteranceId: null,
      isQuestion: false, // corrected below
      turnId: ev.turnId,
      turnIndex: ev.turnIndex,
      status: ev.status,
      trigger: ev.trigger,
    });

    // End this utterance in our VAD machine if it hasn't already ended.
    this.vad.onUtteranceFinalized();
    this._gateOpen = false;

    if (fin) {
      const ask = this._ask;
      if (ask && ask.turnId === ev.turnId && (ask.viaEager || ask.viaPartial) && !ask.wasCancelled && !ask.firstTokenEmitted && ev.transcript !== ask.question) {
        // The early (eager/partial) draft was stale/incomplete and generation
        // hasn't started: kick the answer off with the corrected FINAL instead.
        this.log('[voice] restarting early answer with corrected final transcript');
        this.questionCount--; // the early draft already counted this question
        this.#cancelActiveAsk();
        this.#tryAskQuestion(ev.transcript, { turnId: ev.turnId, status: ev.status, viaEager: false });
      } else if (ask && ask.turnId === ev.turnId && (ask.viaEager || ask.viaPartial) && !ask.wasCancelled) {
        // Answer already streaming on the early draft — record the corrected
        // final as the asked question so conversation/history stay accurate.
        ask.question = ev.transcript;
        this.#tryAskQuestion(ev.transcript, { turnId: ev.turnId, status: ev.status, viaEager: false });
      } else {
        this.#tryAskQuestion(ev.transcript, { turnId: ev.turnId, status: ev.status, viaEager: false });
      }
    } else {
      // Duplicate final (already handled — e.g. answered from the eager draft).
      this.phase = this.#readyPhase();
      this.#broadcastState();
    }
  }

  #tryAskQuestion(transcript, { turnId, status, viaEager = false, viaPartial = false }) {
    this.latency.mark('questionDetected');
    const q = detectQuestion(transcript);
    this.emitToRenderer('voice:classified', { isQuestion: q.isQuestion, confidence: q.confidence, kind: q.kind, turnId });

    if (!q.isQuestion) {
      // A statement (not a question) supersedes an early-started answer for
      // this turn — cancel the in-flight generation instead of answering away.
      const active = this._ask;
      if (active && active.turnId === turnId && (active.viaEager || active.viaPartial) && !active.wasCancelled) {
        this.log('[voice] early answer cancelled: final transcript is not a question');
        this.#cancelActiveAsk();
      }
      this.phase = this.#readyPhase();
      this.#broadcastState();
      return null;
    }
    if (this._ask && this._ask.turnId === turnId && this._ask.asked && !this._ask.wasCancelled) {
      return null; // already answered this turn (early draft did it)
    }
    this.questionCount++;
    this.lastQuestion = transcript;
    this.phase = PHASE.PROCESSING;
    this.latency.mark('aiRequestStart');
    this.#broadcastState();
    return this.#askAI(transcript, { turnId, status, viaEager, viaPartial });
  }

  #onSttError(err) {
    if (err && err.code === 'NO_API_KEY') {
      this.#reportError({ type: 'stt', code: 'STT_NOT_CONFIGURED', userMessage: 'Streaming STT not connected — add a Deepgram API key in Settings to enable live transcription.' });
    } else {
      this.#reportError({ type: 'stt', code: err && err.code, userMessage: 'Speech-to-text error: ' + ((err && err.message) || 'unknown') });
    }
  }

  // ---------------------------------------------------------------- AI
  #askAI(transcript, { turnId, status, viaEager = false, viaPartial = false }) {
    this.emitToRenderer('voice:ai-started', { question: transcript, turnId, viaEager, viaPartial });
    this._ask = {
      turnId, question: transcript, status, viaEager, viaPartial,
      asked: true, active: true, wasCancelled: false,
    };

    // Single-flight listeners for the current request (interruptions swap
    // these out each time a newer turn supersedes the in-flight one).
    this.ai.removeAllListeners('first-token');
    this.ai.removeAllListeners('first-useful');
    this.ai.removeAllListeners('token');
    this.ai.removeAllListeners('started');
    this.ai.removeAllListeners('done');
    this.ai.removeAllListeners('cancelled');
    this.ai.removeAllListeners('error');

    this.ai.once('first-token', () => {
      this.latency.mark('aiFirstToken');
      if (this._ask && this._ask.turnId === turnId) this._ask.firstTokenEmitted = true;
    });
    this.ai.once('first-useful', (ev) => {
      this.latency.mark('aiFirstUsefulToken');
      this.emitToRenderer('voice:ai-first-token', { ms: ev.ms });
    });
    this.ai.on('token', ({ text }) => {
      this.emitToRenderer('voice:ai-token', { text, turnId });
    });

    const convCtx = this.conversation.compileContextForPrompt();
    // Recent Q→A turns as conversational history (bounded).
    const history = [];
    for (const t of this.conversation.recent.slice(0, 6)) {
      if (t.question) history.push({ role: 'user', content: t.question });
      if (t.answer) history.push({ role: 'assistant', content: t.answer });
    }
    history.push({ role: 'user', content: transcript });

    this.ai.streamAnswer({
      transcript,
      taskType: 'interview',
      history,
      conversationContext: convCtx,
      turnId,
      sessionId: this.sessionId,
    }).then((text) => {
      const ask = this._ask;
      if (text == null || !ask || ask.turnId !== turnId) return; // cancelled / superseded
      this.answerCount++;
      this.latency.mark('aiCompleted');
      const rec = this.latency.complete({});
      this.conversation.addTurn({ turnId, question: ask.question, answer: text, status: ask.status });
      this.emitToRenderer('voice:ai-completed', { text, ms: rec ? rec.ms : null, turnId });
      this.emitToRenderer('voice:latency', { last: this.latency.last, stats: this.latency.stats() });
      this.phase = this.#readyPhase();
      this.#broadcastState();
    }).catch((err) => {
      if (this._ask && this._ask.turnId === turnId) {
        this.#reportError({ type: 'ai', code: 'AI_STREAM_FAILED', userMessage: 'Answer stream failed: ' + ((err && err.message) || 'unknown') });
      }
      this.latency.complete({});
      if (this.phase === PHASE.PROCESSING) {
        this.phase = this.#readyPhase();
        this.#broadcastState();
      }
    });
  }

  #readyPhase() {
    return this.phase === PHASE.PROCESSING ? PHASE.LISTENING : (this._ready ? PHASE.LISTENING : PHASE.WARMING_UP);
  }

  // Fire a tiny, silent answer request at startup so the AiClient learns which
  // model the worker actually serves and can use the fast path (explicit
  // single-model request) from the very first real question. The result is
  // discarded; the learned model is persisted by AiClient where configured.
  #probeModel() {
    if (this._probedModel) return;
    this._probedModel = true;
    if (this.deps.ai) return; // injected mocks skip the live probe
    if (this.cfg.probeModelOnStart === false) return;
    if (!(this.cfg.defaultWorkerUrl || this.cfg.workerUrl)) return;
    this.log('[voice] probing worker for the working model…');
    if (this.ai.warmup) this.ai.warmup().then(() => { }, () => { });
    this.ai.streamAnswer({ transcript: 'Reply with OK.', taskType: 'interview', maxTokens: 4, turnId: '__probe_model' })
      .then(() => this.log('[voice] model probe complete'))
      .catch((err) => this.log('[voice] model probe failed:', (err && err.message) || err));
  }

  // --------------------------------------------------------------- ready
  #evaluateReady() {
    const captureOk = this.capture.isCapturing;
    const sttOk = this.stt.isConnected;
    const aiOk = this.ai.warm;
    this._ready = captureOk && sttOk && aiOk;
    if (this._ready && (this.phase === PHASE.WARMING_UP || this.phase === PHASE.STARTING)) {
      this.phase = PHASE.LISTENING;
      this.#broadcastState();
    }
    this.#broadcastState();
  }

  #broadcastState() {
    this.emitToRenderer('voice:state', this.getDiagnostics().state);
  }

  // ----------------------------------------------------------- recovery
  #onCaptureError(err) {
    this.#setSourceState(SRC_STATE.ERROR);
    this.#reportError({ type: 'capture', code: 'CAPTURE_ERROR', userMessage: 'Audio capture error: ' + ((err && err.message) || 'unknown') });
    this.#tryRecover((err && err.message) || 'capture-error');
  }

  #onProcessExit(pid) {
    this.sourceManager.handleProcessExit(pid);
    this.#reportError({ type: 'capture', code: 'PROCESS_EXIT', userMessage: 'Audio source process exited — switching to System Output.', recover: true });
    this.sourceManager.fallbackToDefault().then(() => {
      return this.capture.switchSource(this.sourceManager.selected);
    }).catch((err) => {
      this.#reportError({ type: 'capture', code: 'FALLBACK_FAILED', userMessage: 'Failed to switch audio source: ' + ((err && err.message) || 'unknown') });
    });
  }

  #onDevicesChanged(change) {
    this._lastDeviceChange = change;
    // Default render device changed: our *system* loopback is attached to
    // the default, so restart it to follow (headset ↔ speakers etc.).
    const src = this.sourceManager.selected;
    if (src && src.kind === SRC_KIND.SYSTEM && change.defaultChanged) {
      this.log('[voice] default render device changed → restarting system capture');
      this.#setSourceState(SRC_STATE.SWITCHING);
      const r = this.capture.start({ kind: SRC_KIND.SYSTEM, name: 'System Output (Default device)' });
      if (r.ok) this.#setSourceState(SRC_STATE.CONNECTED);
      else this.#tryRecover(r.error);
    }
  }

  async #tryRecover(reason) {
    this._restartAttempts++;
    if (this._restartAttempts > MAX_RESTART_ATTEMPTS) {
      this.phase = PHASE.ERROR;
      this.#reportError({ type: 'capture', code: 'RECOVERY_FAILED', userMessage: 'Audio capture failed after ' + MAX_RESTART_ATTEMPTS + ' attempts. Restarting service may help.' });
      return;
    }
    this.log(`[voice] recovery attempt ${this._restartAttempts} (${reason})`);
    this.#setSourceState(SRC_STATE.FALLBACK);
    await this.sourceManager.fallbackToDefault();
    await new Promise((r) => { this._restartTimer = setTimeout(r, RESTART_BACKOFF_MS); });
    if (!this._sessionActive) return;
    const r = this.capture.start({ kind: SRC_KIND.SYSTEM, name: 'System Output (Default device)' });
    if (r.ok) {
      this._restartAttempts = 0;
      this.#setSourceState(SRC_STATE.CONNECTED);
      this.#evaluateReady();
    } else {
      await this.#tryRecover(r.error);
    }
  }

  #reportError(ev) {
    this.errors.push(ev);
    if (this.errors.length > 20) this.errors.shift();
    this.emitToRenderer('voice:error', ev);
  }

  // ---------------------------------------------------------------- diag
  getDiagnostics() {
    const deviceSnap = this.deviceManager.snapshot();
    const srcSnap = this.sourceManager.snapshot();
    const capSnap = this.capture.snapshot();
    const sttSnap = this.stt.snapshot();
    const latencyStats = this.latency.stats();
    const turnSnap = this.turnMan.snapshot();
    return {
      state: {
        session: this.phase,
        sessionId: this.sessionId,
        listening: this.listeningEnabled,
        audio: {
          source: srcSnap,
          capture: capSnap,
          flow: {
            framesFedToStt: this.audioFramesFed,
            framesRejectedByStt: this.audioFramesRejected,
            lastFrameAt: this.lastAudioFrameAt || null,
            idleMs: this.lastAudioFrameAt ? Date.now() - this.lastAudioFrameAt : null,
            lastLevel: this.lastAudioLevel,
            sourceChunks: capSnap.chunksReceived,
            processedFrames: capSnap.framesProcessed,
            droppedChunks: capSnap.framesDropped,
            flow: capSnap.framesProcessed > 0 ? 'flowing' : 'no-data',
          },
        },
        stt: sttSnap,
        turn: turnSnap,
        transcript: this.transcript.snapshot(),
        conversation: this.conversation.snapshot(),
        ai: { warm: this.ai.warm },
        ready: this._ready || false,
        counters: {
          utterances: this.utteranceCount,
          questions: this.questionCount,
          answers: this.answerCount,
        },
        lastTranscript: this.lastTranscript,
        lastQuestion: this.lastQuestion,
        device: deviceSnap,
      },
      latency: { last: this.latency.last, stats: latencyStats },
      errors: [...this.errors],
    };
  }
}

module.exports = { VoiceService, PHASE };