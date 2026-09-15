'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { LatencyTracker } = require('../latency-tracker');

function makeTracker(opts = {}) {
  return new LatencyTracker({ maxHistory: 8, ...opts });
}

test('begin + mark + complete produces a single record', () => {
  const t = makeTracker();
  t.begin('utterance');
  t.mark('vadSpeechStart');
  t.mark('sttFinal');
  const rec = t.complete();
  assert.ok(rec);
  assert.strictEqual(rec.name, 'utterance');
  assert.ok(rec.ms > 0);
  assert.ok(rec.totals['vadSpeechStart'] >= 0);
  assert.ok(rec.totals['sttFinal'] >= rec.totals['vadSpeechStart']);
  assert.ok(t.last);
  assert.strictEqual(t.history.length, 1);
});

test('adjacent markers produce a segment measurement', () => {
  const t = makeTracker();
  t.begin('utterance');
  t.mark('audioCaptureStart');
  t.mark('loopbackEmit');
  t.mark('dspFrame');
  const rec = t.complete();
  assert.ok(Object.prototype.hasOwnProperty.call(rec.totals, 'loopbackEmit->dspFrame'));
  assert.ok(rec.totals['loopbackEmit->dspFrame'] >= 0);
});

test('milestone returns elapsed ms since capture start', () => {
  const t = makeTracker();
  t.begin('utterance');
  const a = t.milestone('vadSpeechStart');
  assert.strictEqual(a, null); // not marked yet
  t.mark('vadSpeechStart');
  const b = t.milestone('vadSpeechStart');
  assert.ok(typeof b === 'number' && b >= 0);
});

test('complete without begin is a safe no-op', () => {
  const t = makeTracker();
  const rec = t.complete();
  assert.strictEqual(rec, null);
});

test('stats compute percentiles across records', () => {
  const t = makeTracker();
  for (let i = 1; i <= 5; i++) {
    t.begin('u');
    t.mark('sttFinal');
    t.complete();
  }
  const s = t.stats();
  assert.ok(s.total.count === 5);
  assert.ok(s.total.min <= s.total.max);
  assert.ok(s.total.p50 >= s.total.min && s.total.p50 <= s.total.max);
  assert.ok(s.total.p95 <= s.total.max);
});

test('history is bounded by maxHistory', () => {
  const t = makeTracker({ maxHistory: 3 });
  for (let i = 0; i < 10; i++) {
    t.begin('u');
    t.mark('sttFinal');
    t.complete();
  }
  assert.ok(t.history.length <= 3);
});

test('now() is monotonic and advances', () => {
  const t = makeTracker();
  const a = t.now();
  const b = t.now();
  assert.ok(b >= a);
});