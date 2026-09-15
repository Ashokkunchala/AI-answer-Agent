// transcript-manager.js — owns the live per-turn transcript state.
//
// Deepgram Flux delivers the ENTIRE turn transcript on every TurnInfo event
// (StartOfTurn, Update, EagerEndOfTurn, TurnResumed, EndOfTurn). This manager
// therefore *replaces* a turn's text snapshot-by-snapshot (partial → final
// replacement is inherent) rather than stitching partial words. It also:
//   - ignores out-of-order events via sequence_id,
//   - de-duplicates repeat EndOfTurn deliveries,
//   - keeps a bounded per-turnIndex memory so long sessions don't grow unbounded.
'use strict';

const { EventEmitter } = require('events');

class TranscriptManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxTurnMemory = options.maxTurnMemory || 50;
    this._partials = new Map();  // turnIndex -> { text, sequenceId }
    this._finals = new Map();    // turnIndex -> { transcript, at, trigger }
  }

  // StartOfTurn (or a legacy provider's first utterance).
  beginTurn(turnIndex, transcript = '', { sequenceId } = {}) {
    const existing = this._partials.get(turnIndex);
    if (existing && sequenceId != null && existing.sequenceId > sequenceId) {
      return null; // out-of-order — ignore
    }
    if (!existing) {
      this._partials.set(turnIndex, { text: transcript, sequenceId: sequenceId != null ? sequenceId : -1 });
    } else {
      existing.text = transcript;
      if (sequenceId != null) existing.sequenceId = sequenceId;
    }
    this.#trim();
    return this.#emitPartial(turnIndex, transcript);
  }

  // Update / other partial-bearing event.
  updateTurn(turnIndex, transcript = '', { sequenceId } = {}) {
    const existing = this._partials.get(turnIndex);
    if (existing && sequenceId != null && existing.sequenceId > sequenceId) {
      return null; // stale
    }
    const before = existing ? existing.text : null;
    if (existing) {
      existing.text = transcript;
      if (sequenceId != null) existing.sequenceId = sequenceId;
    } else {
      this._partials.set(turnIndex, { text: transcript, sequenceId: sequenceId != null ? sequenceId : -1 });
    }
    this.#trim();
    if (before === transcript) return null; // same text — already current
    return this.#emitPartial(turnIndex, transcript);
  }

  // Register a final transcript for a turn. Returns null when it's a duplicate
  // (same turnIndex + same text, already final) — the common case under the
  // adaptive turn manager's local/Flux dual paths.
  finalizeTurn(turnIndex, transcript = '', { trigger = null, at = Date.now() } = {}) {
    const prior = this._finals.get(turnIndex);
    if (prior && prior.transcript === transcript) {
      return null; // duplicate
    }
    const rec = { turnIndex, transcript, at, trigger, final: true };
    this._finals.set(turnIndex, rec);
    this.#trim();
    this.emit('final', rec);
    return rec;
  }

  getTurnText(turnIndex) {
    const p = this._partials.get(turnIndex);
    return p ? p.text : '';
  }

  getFinal(turnIndex) {
    return this._finals.get(turnIndex) || null;
  }

  #emitPartial(turnIndex, transcript) {
    if (transcript == null) return null;
    const ev = { turnIndex, transcript, partial: true };
    this.emit('partial', ev);
    return ev;
  }

  #trim() {
    if (this._partials.size <= this.maxTurnMemory && this._finals.size <= this.maxTurnMemory) return;
    const prune = (map) => {
      const keys = [...map.keys()].sort((a, b) => a - b);
      while (keys.length > this.maxTurnMemory) map.delete(keys.shift());
    };
    prune(this._partials);
    prune(this._finals);
  }

  reset() {
    this._partials.clear();
    this._finals.clear();
  }

  snapshot() {
    return {
      partialTurns: this._partials.size,
      finalTurns: this._finals.size,
    };
  }
}

module.exports = { TranscriptManager };