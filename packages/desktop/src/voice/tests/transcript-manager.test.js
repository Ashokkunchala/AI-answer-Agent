'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { TranscriptManager } = require('../transcript-manager');

test('beginTurn emits a partial and records the text', () => {
  const tm = new TranscriptManager();
  const seen = [];
  tm.on('partial', (ev) => seen.push(ev));
  tm.beginTurn(3, 'hello world');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].turnIndex, 3);
  assert.strictEqual(seen[0].transcript, 'hello world');
  assert.strictEqual(tm.getTurnText(3), 'hello world');
});

test('updateTurn replaces the full-turn snapshot', () => {
  const tm = new TranscriptManager();
  tm.beginTurn(1, 'how do');
  tm.updateTurn(1, 'how do i');
  assert.strictEqual(tm.getTurnText(1), 'how do i');
});

test('identical update does not re-emit (partial dedup)', () => {
  const tm = new TranscriptManager();
  const seen = [];
  tm.on('partial', (ev) => seen.push(ev));
  tm.beginTurn(5, 'same text');
  const result = tm.updateTurn(5, 'same text');
  assert.strictEqual(result, null);
  assert.strictEqual(seen.length, 1);
});

test('out-of-order events are ignored via sequenceId', () => {
  const tm = new TranscriptManager();
  tm.beginTurn(2, 'a', { sequenceId: 10 });
  tm.updateTurn(2, 'b', { sequenceId: 5 });
  assert.strictEqual(tm.getTurnText(2), 'a');
  tm.updateTurn(2, 'c', { sequenceId: 12 });
  assert.strictEqual(tm.getTurnText(2), 'c');
});

test('finalizeTurn records a final and de-dupes repeated delivery', () => {
  const tm = new TranscriptManager();
  const finals = [];
  tm.on('final', (f) => finals.push(f));
  const a = tm.finalizeTurn(1, 'what is kubernetes', { trigger: 'model' });
  assert.ok(a);
  assert.strictEqual(a.transcript, 'what is kubernetes');
  const b = tm.finalizeTurn(1, 'what is kubernetes', { trigger: 'model' });
  assert.strictEqual(b, null); // duplicate
  assert.strictEqual(finals.length, 1);
  assert.strictEqual(tm.getFinal(1).transcript, 'what is kubernetes');
});

test('finalizeTurn allows an improved transcript for the same turn', () => {
  const tm = new TranscriptManager();
  tm.finalizeTurn(1, 'what is kubernetes');
  const improved = tm.finalizeTurn(1, 'what is kubernetes in devops');
  assert.ok(improved);
  assert.strictEqual(tm.getFinal(1).transcript, 'what is kubernetes in devops');
});

test('memory is bounded', () => {
  const tm = new TranscriptManager({ maxTurnMemory: 3 });
  for (let i = 0; i < 10; i++) {
    tm.beginTurn(i, `turn ${i}`);
    tm.finalizeTurn(i, `turn ${i}`);
  }
  assert.ok(tm._partials.size <= 3);
  assert.ok(tm._finals.size <= 3);
  assert.strictEqual(tm.snapshot().finalTurns, 3);
});

test('reset clears all state', () => {
  const tm = new TranscriptManager();
  tm.beginTurn(1, 'x');
  tm.finalizeTurn(1, 'x');
  tm.reset();
  assert.strictEqual(tm.snapshot().partialTurns, 0);
  assert.strictEqual(tm.snapshot().finalTurns, 0);
});