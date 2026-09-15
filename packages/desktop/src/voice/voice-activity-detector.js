// voice-activity-detector.js — external speech state machine.
//
// The DSP pipeline already produces per-frame energy VAD + classifier flags.
// This detector turns those per-frame flags into the coarser conversation
// states the service needs, with hysteresis so a natural pause inside a
// phrase is never mistaken for the end of the sentence:
//
//   IDLE -> SPEAKING -> PAUSED  -> SPEECH_END -> FINALIZING -> IDLE
//                        (resume) -> SPEAKING
//                                  (new speech while FINALIZING) -> SPEAKING
//   any -> ERROR -> (recover) -> IDLE
//
// State is driven by (a) per-frame speech flags when audio is arriving and
// (b) monotonic time gaps when the native capture drops silent buffers
// (loopback) so "silence" never arrives as data.
'use strict';

const State = {
  IDLE: 'IDLE',
  SPEAKING: 'SPEAKING',
  PAUSED: 'PAUSED',
  SPEECH_END: 'SPEECH_END',
  FINALIZING: 'FINALIZING',
  ERROR: 'ERROR',
};

const DEFAULT_TIMINGS = {
  pauseResumeMs: 300,     // gap that flips SPEAKING -> PAUSED
  speechEndMs: 700,       // cumulative gap that flips PAUSED -> SPEECH_END
  minSpeechMs: 200,       // ignore blips shorter than this
  finalizeTimeoutMs: 1200, // max time spent in FINALIZING before service forces end
};

class VoiceActivityDetector {
  constructor(options = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...options };
    this.state = State.IDLE;
    this.speechStartNs = null;
    this.lastSpeechNs = null;
    this.lastEndNs = null;
    this.speechDurationMs = 0;
    this.level = 0;
    this.onStateChange = options.onStateChange || null;
    this.onSpeechStart = options.onSpeechStart || null;
    this.onSpeechEnd = options.onSpeechEnd || null;
    this._finalizeStartNs = null;
  }

  getState() {
    return this.state;
  }

  reset() {
    this.state = State.IDLE;
    this.speechStartNs = null;
    this.lastSpeechNs = null;
    this.lastEndNs = null;
    this.speechDurationMs = 0;
    this.level = 0;
    this._finalizeStartNs = null;
  }

  #set(state, nowNs) {
    if (state === this.state) return;
    const prev = this.state;
    this.state = state;
    if (state === State.SPEAKING) {
      this.speechStartNs = nowNs;
    }
    if (this.onStateChange) {
      try { this.onStateChange(state, prev); } catch (_) { /* ignore */ }
    }
  }

  #speechOnset(nowNs) {
    if (this.state === State.IDLE || this.state === State.ERROR) {
      this.#set(State.SPEAKING, nowNs);
      if (this.onSpeechStart) {
        try { this.onSpeechStart(nowNs); } catch (_) { /* ignore */ }
      }
    } else if (
      this.state === State.PAUSED ||
      this.state === State.FINALIZING ||
      this.state === State.SPEECH_END
    ) {
      // Interviewer resumes over a pause, or before finalization completed —
      // reopen the utterance. speechStartNs intentionally keeps the original
      // onset so total spoken duration stays meaningful across pauses.
      const onset = this.speechStartNs;
      this._finalizeStartNs = null;
      this.#set(State.SPEAKING, nowNs);
      if (onset != null) this.speechStartNs = onset;
    }
  }

  // Process an audio frame produced by the DSP pipeline.
  process(frame) {
    const nowNs = frame.nowNs ?? process.hrtime.bigint();
    this.level = frame.level ?? this.level;

    if (frame.speech) {
      this.lastSpeechNs = nowNs;
      if (this.state !== State.SPEAKING) this.#speechOnset(nowNs);
      else this.speechDurationMs = nsToMs(nowNs - this.speechStartNs);
      return this.state;
    }

    // Non-speech frame while already talking => let tick() decide via timing.
    return this.state;
  }

  // Called on a timer (e.g. every 20-40ms) so gap-based transitions happen
  // even when no frames arrive (loopback capture drops silence).
  tick(nowNs = process.hrtime.bigint()) {
    if (this.state === State.SPEAKING && this.lastSpeechNs !== null) {
      const gapMs = nsToMs(nowNs - this.lastSpeechNs);
      if (gapMs >= this.timings.pauseResumeMs) {
        this.#set(State.PAUSED, nowNs);
      }
    }

    if (this.state === State.PAUSED) {
      const gapMs = nsToMs(nowNs - this.lastSpeechNs);
      if (gapMs >= this.timings.speechEndMs) {
        this.#endSpeech(nowNs);
      } else if (gapMs < this.timings.pauseResumeMs) {
        this.#set(State.SPEAKING, nowNs);
      }
    }

    if (this.state === State.FINALIZING) {
      if (this._finalizeStartNs === null) this._finalizeStartNs = nowNs;
      const elapsing = nsToMs(nowNs - this._finalizeStartNs);
      // Service is normally notified of the STT final; this timer only
      // force-ends if the transcript provider stalls.
      if (elapsing >= this.timings.finalizeTimeoutMs) {
        this.#endSpeech(nowNs, { forced: true });
      }
    }
  }

  #endSpeech(nowNs, opts = {}) {
    // Gate on the actual spoken block (onset -> last speech frame) so a brief
    // blip plus a long pause is still treated as noise, not an utterance.
    const spokeMs = this.speechStartNs != null && this.lastSpeechNs != null
      ? nsToMs(this.lastSpeechNs - this.speechStartNs)
      : 0;
    this.speechDurationMs = spokeMs;
    this.lastEndNs = nowNs;

    if (spokeMs < this.timings.minSpeechMs) {
      // Ignore blip — straight back to idle without an "end".
      this.#set(State.IDLE, nowNs);
      this.lastSpeechNs = null;
      return;
    }

    this.#set(State.SPEECH_END, nowNs);
    this._finalizeStartNs = null;
    if (this.onSpeechEnd) {
      try { this.onSpeechEnd({ durationMs: spokeMs, nowNs, forced: !!opts.forced }); } catch (_) { /* ignore */ }
    }
  }

  // Transition to FINALIZING once the utterance is handed to the STT
  // provider to produce its final transcript.
  finalizing() {
    if (this.state === State.SPEECH_END) {
      this.#set(State.FINALIZING, process.hrtime.bigint());
    }
  }

  onUtteranceFinalized() {
    this.#set(State.IDLE, process.hrtime.bigint());
    this.lastSpeechNs = null;
  }

  onError() {
    this.#set(State.ERROR, process.hrtime.bigint());
  }

  snapshot() {
    return {
      state: this.state,
      speechDurationMs: Math.round(this.speechDurationMs),
    };
  }
}

function nsToMs(ns) {
  return Number(ns) / 1_000_000;
}

module.exports = { VoiceActivityDetector, State };