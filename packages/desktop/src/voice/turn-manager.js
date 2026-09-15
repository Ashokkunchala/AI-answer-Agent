// turn-manager.js — maps STT turn signals + local end-of-speech onto a single
// "turn lifecycle" the voice service drives from.
//
// Turn semantics (adaptive — no fixed setTimeout is the primary mechanism):
//   - A turn opens on the first TurnInfo event for a new turn_index.
//   - It ends when EndOfTurn arrives from Flux (status flux-eot / flux-manual),
//     OR — only after local VAD speech-end AND no EndOfTurn within `endGraceMs`
//     — it is closed locally (status local). The grace timer is a fallback, not
//     the normal path: with Flux's model-integrated end-of-turn detection the
//     EndOfTurn event usually lands well inside the grace window.
//   - EagerEndOfTurn is surfaced once per turn so the service can pre-start
//     answer generation and then cancel it if TurnResumed arrives.
//   - Refires on TurnResumed are de-duplicated per turn via turnId.
'use strict';

const { EventEmitter } = require('events');

class TurnManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || '';
    this.eagerEnabled = options.eagerEnabled !== false;
    this.eagerEotThreshold = options.eagerEotThreshold ?? 0.5;
    this.endGraceMs = options.endGraceMs ?? 800;
    this.maxCompletedTurns = options.maxCompletedTurns ?? 200;
    this.log = options.log || ((..._a) => { });

    this._seq = 0;
    this._current = null;              // { turnId, turnIndex, transcript, finished }
    this._completedTurns = new Set();  // turnIndexes already completed
    this._graceTimer = null;
  }

  current() {
    return this._current ? { ...this._current } : null;
  }

  // Feed a normalized Flux event:
  //   { kind:'start'|'update'|'eager-end'|'turn-resumed'|'final',
  //     turnIndex, sequenceId, transcript, endOfTurnConfidence, trigger }
  onFlux(ev) {
    if (!ev) return null;
    if (ev.turnIndex == null) return this.#handleLegacy(ev);

    if (this._completedTurns.has(ev.turnIndex)) return null; // stale turn

    if (ev.kind === 'start' || ev.kind === 'update') {
      if (!this._current || this._current.turnIndex !== ev.turnIndex) {
        this.#beginTurn(ev.turnIndex, ev.transcript);
      } else {
        this._current.transcript = ev.transcript;
      }
      const c = this._current;
      this.emit('partial', { turnId: c.turnId, turnIndex: ev.turnIndex, transcript: ev.transcript });
      return { ...c };
    }

    if (ev.kind === 'eager-end') {
      if (!this._current || this._current.turnIndex !== ev.turnIndex) {
        this.#beginTurn(ev.turnIndex, ev.transcript);
      } else {
        this._current.transcript = ev.transcript;
      }
      const c = this._current;
      if (this.eagerEnabled && !c.eagerSent) {
        const conf = ev.endOfTurnConfidence != null ? ev.endOfTurnConfidence : 1;
        if (this.eagerEotThreshold == null || conf >= this.eagerEotThreshold) {
          c.eagerSent = true;
          this.emit('eager', {
            turnId: c.turnId,
            turnIndex: ev.turnIndex,
            transcript: ev.transcript,
            endOfTurnConfidence: conf,
            status: 'eager',
          });
        }
      }
      return { ...c };
    }

    if (ev.kind === 'turn-resumed') {
      if (this._current && this._current.turnIndex === ev.turnIndex) {
        this._current.transcript = ev.transcript;
        this._current.eagerCancelled = true;
      }
      this.emit('turn-resumed', {
        turnId: this._current ? this._current.turnId : null,
        turnIndex: ev.turnIndex,
        transcript: ev.transcript,
      });
      return { ...this._current };
    }

    if (ev.kind === 'final') {
      if (!this._current || this._current.turnIndex !== ev.turnIndex) {
        this.#beginTurn(ev.turnIndex, ev.transcript);
      } else {
        this._current.transcript = ev.transcript;
      }
      const status = ev.trigger === 'manual' ? 'flux-manual' : ev.trigger === 'timeout' ? 'timeout' : 'flux-eot';
      return this.#completeTurn(ev.turnIndex, ev.transcript, {
        trigger: ev.trigger,
        status,
        endOfTurnConfidence: ev.endOfTurnConfidence,
      });
    }
    return null;
  }

  // Local VAD says speech ended. If the Flux turn is still open, wait a grace
  // window for EndOfTurn; if nothing arrives, close the turn locally.
  onLocalSpeechEnd() {
    if (this._current && !this._current.finished) this.#armGrace();
  }

  onLocalSpeechStart() {
    this.#clearGrace();
  }

  #armGrace() {
    this.#clearGrace();
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (!this._current || this._current.finished) return;
      this.log('[turn] EndOfTurn missed within grace; closing locally');
      this.#completeTurn(this._current.turnIndex, this._current.transcript, {
        trigger: 'local',
        status: 'local',
        forcedByTimer: true,
      });
    }, this.endGraceMs);
    if (this._graceTimer.unref) this._graceTimer.unref();
  }

  #clearGrace() {
    if (this._graceTimer) { clearTimeout(this._graceTimer); this._graceTimer = null; }
  }

  #beginTurn(turnIndex, transcript) {
    this.#clearGrace();
    this._seq++;
    const prev = this._current;
    if (prev && !prev.finished) {
      this.emit('turn-interrupted', { turnId: prev.turnId, turnIndex: prev.turnIndex });
    }
    this._current = {
      turnId: `T${this._seq}`,
      turnIndex,
      transcript: transcript || '',
      eagerSent: false,
      eagerCancelled: false,
      finished: false,
    };
    this.emit('turn-start', { turnId: this._current.turnId, turnIndex });
  }

  #completeTurn(turnIndex, transcript, meta) {
    this.#clearGrace();
    const c = this._current;
    if (!c) return null;
    c.finished = true;
    c.transcript = transcript;
    this._completedTurns.add(turnIndex);
    this.#capCompletedTurns();
    const ev = { turnId: c.turnId, turnIndex, transcript, ...meta };
    this.emit('turn-complete', ev);
    return ev;
  }

  // Keep the completed-turns set bounded so a long session can't grow memory
  // without limit. Insertion order is oldest→newest, so prune from the front
  // (we only need to ignore recent dupes anyway).
  #capCompletedTurns() {
    if (this._completedTurns.size <= this.maxCompletedTurns) return;
    const excess = this._completedTurns.size - this.maxCompletedTurns;
    const it = this._completedTurns.values();
    for (let i = 0; i < excess; i++) {
      this._completedTurns.delete(it.next().value);
    }
  }

  // Legacy fallback: Flux messages without a turn_index (or a v1 provider).
  #handleLegacy(ev) {
    if (!ev || !ev.transcript) return null;
    if (ev.kind === 'final') {
      if (!this._current || this._current.finished) this.#beginTurn(-1, ev.transcript);
      else this._current.transcript = ev.transcript;
      return this.#completeTurn(-1, ev.transcript, { trigger: ev.trigger, status: 'flux-eot' });
    }
    if (ev.kind === 'start' || ev.kind === 'update') {
      if (!this._current || this._current.finished) this.#beginTurn(-1, ev.transcript);
      else this._current.transcript = ev.transcript;
      this.emit('partial', { turnId: this._current.turnId, turnIndex: -1, transcript: ev.transcript });
    }
    return null;
  }

  reset() {
    this.#clearGrace();
    this._current = null;
    this._completedTurns.clear();
    this._seq = 0;
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      turnId: this._current ? this._current.turnId : null,
      turnIndex: this._current ? this._current.turnIndex : null,
      transcript: this._current ? this._current.transcript : '',
      open: !!(this._current && !this._current.finished),
      eagerEnabled: this.eagerEnabled,
      eagerEotThreshold: this.eagerEotThreshold,
      endGraceMs: this.endGraceMs,
      completedTurns: this._completedTurns.size,
    };
  }
}

module.exports = { TurnManager };