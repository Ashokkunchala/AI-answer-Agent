'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { TurnManager } = require('../turn-manager');

function collect(tm) {
  const events = { list: [], on: (name) => tm.on(name, (ev) => events.list.push({ name, ev })) };
  ['turn-start', 'partial', 'eager', 'turn-resumed', 'turn-complete', 'turn-interrupted'].forEach((n) => events.on(n));
  return events;
}

test('StartOfTurn begins a turn and emits partials', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 1, transcript: 'how do', sequenceId: 1 });
  assert.strictEqual(evs.list[0].name, 'turn-start');
  assert.ok(evs.list[0].ev.turnId);
  assert.strictEqual(evs.list[1].name, 'partial');
  assert.strictEqual(tm.current().turnIndex, 1);
});

test('EagerEndOfTurn is emitted once per turn even if repeated', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 2, transcript: 'q?', sequenceId: 1 });
  tm.onFlux({ kind: 'eager-end', turnIndex: 2, transcript: 'q?', sequenceId: 2, endOfTurnConfidence: 0.8 });
  tm.onFlux({ kind: 'eager-end', turnIndex: 2, transcript: 'q?', sequenceId: 3, endOfTurnConfidence: 0.9 });
  const eagers = evs.list.filter((e) => e.name === 'eager');
  assert.strictEqual(eagers.length, 1);
  assert.strictEqual(eagers[0].ev.status, 'eager');
});

test('eager gated by threshold confidence', () => {
  const tm = new TurnManager({ eagerEotThreshold: 0.9 });
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 3, transcript: 'low?', sequenceId: 1 });
  tm.onFlux({ kind: 'eager-end', turnIndex: 3, transcript: 'low?', sequenceId: 2, endOfTurnConfidence: 0.4 });
  assert.strictEqual(evs.list.filter((e) => e.name === 'eager').length, 0);
});

test('eager disabled yields no eager event', () => {
  const tm = new TurnManager({ eagerEnabled: false });
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 4, transcript: 'any?', sequenceId: 1 });
  tm.onFlux({ kind: 'eager-end', turnIndex: 4, transcript: 'any?', sequenceId: 2, endOfTurnConfidence: 0.9 });
  assert.strictEqual(evs.list.filter((e) => e.name === 'eager').length, 0);
});

test('TurnResumed surfaces and marks the eager draft cancelled', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 5, transcript: 'a?', sequenceId: 1 });
  tm.onFlux({ kind: 'eager-end', turnIndex: 5, transcript: 'a?', sequenceId: 2, endOfTurnConfidence: 0.9 });
  tm.onFlux({ kind: 'turn-resumed', turnIndex: 5, transcript: 'a and b', sequenceId: 3 });
  const resumed = evs.list.find((e) => e.name === 'turn-resumed');
  assert.ok(resumed);
  assert.strictEqual(tm.current().eagerCancelled, true);
});

test('EndOfTurn completes the turn via Flux', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 6, transcript: 'final q?', sequenceId: 1 });
  const complete = tm.onFlux({ kind: 'final', turnIndex: 6, transcript: 'final q?', sequenceId: 2, trigger: 'model' });
  assert.ok(complete);
  assert.strictEqual(complete.status, 'flux-eot');
  const done = evs.list.find((e) => e.name === 'turn-complete');
  assert.ok(done);
  assert.strictEqual(done.ev.transcript, 'final q?');
});

test('manual trigger maps to flux-manual status', () => {
  const tm = new TurnManager();
  tm.onFlux({ kind: 'start', turnIndex: 7, transcript: 'm', sequenceId: 1 });
  const complete = tm.onFlux({ kind: 'final', turnIndex: 7, transcript: 'm', sequenceId: 2, trigger: 'manual' });
  assert.strictEqual(complete.status, 'flux-manual');
});

test('stale finals for a completed turn are ignored', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 8, transcript: 'x', sequenceId: 1 });
  tm.onFlux({ kind: 'final', turnIndex: 8, transcript: 'x', sequenceId: 2 });
  const again = tm.onFlux({ kind: 'final', turnIndex: 8, transcript: 'x better', sequenceId: 3 });
  assert.strictEqual(again, null);
  assert.strictEqual(evs.list.filter((e) => e.name === 'turn-complete').length, 1);
});

test('new turn while previous open emits turn-interrupted', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 9, transcript: 'pending', sequenceId: 1 });
  tm.onFlux({ kind: 'start', turnIndex: 10, transcript: 'next', sequenceId: 1 });
  const interrupted = evs.list.find((e) => e.name === 'turn-interrupted');
  assert.ok(interrupted);
  assert.strictEqual(tm.current().turnIndex, 10);
});

test('local VAD end-of-speech completes an open turn after grace', async () => {
  const tm = new TurnManager({ endGraceMs: 10, log: () => {} });
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 11, transcript: 'local q?', sequenceId: 1 });
  tm.onLocalSpeechEnd();
  await new Promise((r) => setTimeout(r, 40));
  const done = evs.list.find((e) => e.name === 'turn-complete');
  assert.ok(done);
  assert.strictEqual(done.ev.status, 'local');
  assert.ok(done.ev.forcedByTimer === true);
});

test('local grace is cancelled when Flux EndOfTurn wins the race', async () => {
  const tm = new TurnManager({ endGraceMs: 500, log: () => {} });
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', turnIndex: 12, transcript: 'race?', sequenceId: 1 });
  tm.onLocalSpeechEnd();
  tm.onFlux({ kind: 'final', turnIndex: 12, transcript: 'race?', sequenceId: 2, trigger: 'model' });
  await new Promise((r) => setTimeout(r, 30));
  const completes = evs.list.filter((e) => e.name === 'turn-complete');
  assert.strictEqual(completes.length, 1);
  assert.strictEqual(completes[0].ev.status, 'flux-eot');
});

test('legacy events without turnIndex complete via fallback', () => {
  const tm = new TurnManager();
  const evs = collect(tm);
  tm.onFlux({ kind: 'start', transcript: 'legacy', sequenceId: 1 });
  const complete = tm.onFlux({ kind: 'final', transcript: 'legacy', sequenceId: 2 });
  assert.ok(complete);
  assert.strictEqual(complete.turnIndex, -1);
});

test('reset clears state', () => {
  const tm = new TurnManager();
  tm.onFlux({ kind: 'start', turnIndex: 1, transcript: 'x', sequenceId: 1 });
  tm.reset();
  assert.strictEqual(tm.current(), null);
  assert.strictEqual(tm.snapshot().completedTurns, 0);
});

test('completed-turns history is bounded by maxCompletedTurns', () => {
  const tm = new TurnManager({ maxCompletedTurns: 10 });
  for (let i = 0; i < 30; i++) {
    tm.onFlux({ kind: 'start', turnIndex: i, transcript: `t${i}`, sequenceId: i * 2 });
    tm.onFlux({ kind: 'final', turnIndex: i, transcript: `t${i}`, sequenceId: i * 2 + 1 });
  }
  assert.strictEqual(tm.snapshot().completedTurns, 10);
  const dup = tm.onFlux({ kind: 'final', turnIndex: 29, transcript: 'stale dup', sequenceId: 9999 });
  assert.strictEqual(dup, null, 'recently completed turn must still be deduped');
});