// latency-tracker.js — end-to-end latency instrumentation.
// Uses monotonic high-resolution clocks (process.hrtime.bigint()) so timer
// adjustments / wall-clock jumps can never corrupt measurements.
'use strict';

const NANOS_PER_MS = 1_000_000n;
const NANOS_PER_US = 1_000n;

function nsToMs(ns) {
  return Number(ns) / 1_000_000;
}

// P-th percentile of a sorted numeric array.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function percentileStats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : 0,
    max: sorted.length ? sorted[sorted.length - 1] : 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    avg: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
  };
}

// Well-known latency marker positions (mirrors the spec's latency budget):
// audioCaptureStart -> loopbackEmit -> dspFrame -> vadSpeechStart -> firstPartial
// -> vadSpeechEnd -> sttUtteranceFlush -> sttFinal -> questionDetected ->
// aiRequestStart -> aiFirstToken -> aiFirstUsefulToken -> aiCompleted -> uiRender.
const MARKER_ORDER = [
  'audioCaptureStart',
  'loopbackEmit',
  'dspFrame',
  'vadSpeechStart',
  'firstPartial',
  'vadSpeechEnd',
  'sttUtteranceFlush',
  'sttFinal',
  'questionDetected',
  'aiRequestStart',
  'aiFirstToken',
  'aiFirstUsefulToken',
  'aiCompleted',
  'uiRender',
];

class LatencyTracker {
  constructor(options = {}) {
    this.maxHistory = options.maxHistory || 100;
    this.history = [];           // { id, marks: {mark: ns}, totals: {...} }
    this.markers = options.markers || MARKER_ORDER;
    this._lastId = 0;
    this.last = null;            // most recent snapshot (in ms)
    this.tracking = null;        // current open utterance path
  }

  now() {
    return process.hrtime.bigint();
  }

  nowMs() {
    return nsToMs(this.now());
  }

  begin(name) {
    const id = 'ut-' + (++this._lastId).toString(36);
    const marks = Object.create(null);
    marks.audioCaptureStart = this.now();
    this.tracking = { id, name, marks };
    return this.tracking;
  }

  mark(marker, ns = this.now()) {
    if (!this.tracking) {
      // Empty tracking means nothing to attach to; drop silently (caller
      // normally calls begin() first).
      return null;
    }
    this.tracking.marks[marker] = ns;
    return ns;
  }

  milestone(marker) {
    // Elapsed ms since audioCaptureStart for a given marker (if present).
    if (!this.tracking) return 0;
    const start = this.tracking.marks.audioCaptureStart;
    const at = this.tracking.marks[marker];
    if (start === undefined || at === undefined) return null;
    return nsToMs(at - start);
  }

  complete(extras = {}) {
    if (!this.tracking) return null;
    const { id, marks, name } = this.tracking;
    marks.aiCompleted = extras.aiCompleted || marks.aiCompleted || this.now();
    const startNs = marks.audioCaptureStart;

    const totals = {};
    for (let i = 0; i < this.markers.length; i++) {
      const a = this.markers[i - 1];
      const b = this.markers[i];
      if (marks[b] === undefined) continue;
      // Guard against marker arrival inversion (events can legitimately race);
      // a negative segment is meaningless, so it is skipped, not recorded.
      if (a && marks[a] !== undefined && marks[b] >= marks[a]) {
        totals[`${a}->${b}`] = nsToMs(marks[b] - marks[a]);
      }
      totals[b] = nsToMs(marks[b] - startNs);
    }

    const rec = {
      id,
      name,
      ms: nsToMs((extras.aiCompleted || this.now()) - startNs),
      totals,
    };
    this.history.push(rec);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.last = this.#snapshotTail(rec);
    this.tracking = null;
    return rec;
  }

  #snapshotTail(rec) {
    // Convert a completed record to a ms-based snapshot for consumers.
    const out = { ...rec };
    out.marks = Object.fromEntries(
      Object.entries(rec.totals).map(([k, v]) => [k, Math.round(v * 100) / 100])
    );
    return out;
  }

  stats() {
    const segs = {};
    const fulls = this.history.map((r) => r.ms);
    for (const rec of this.history) {
      for (const [k, v] of Object.entries(rec.totals)) {
        (segs[k] ??= []).push(v);
      }
    }
    const out = { total: percentileStats(fulls) };
    for (const [k, v] of Object.entries(segs)) out[k] = percentileStats(v);
    return out;
  }

  resetHistory() {
    this.history = [];
    this.last = null;
  }
}

module.exports = {
  LatencyTracker,
  nsToMs,
  percentileStats,
  MARKER_ORDER,
};