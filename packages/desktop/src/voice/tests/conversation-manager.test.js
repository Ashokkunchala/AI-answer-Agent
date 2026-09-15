'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { ConversationManager } = require('../conversation-manager');

test('recent turns accumulate in order', () => {
  const cm = new ConversationManager({ keepRecent: 6 });
  cm.addTurn({ turnId: 'T1', question: 'q1', answer: 'a1' });
  cm.addTurn({ turnId: 'T2', question: 'q2', answer: 'a2' });
  assert.strictEqual(cm.totalTurns, 2);
  assert.strictEqual(cm.recent.length, 2);
  assert.strictEqual(cm.recent[0].question, 'q1');
});

test('overflow recent turns slide into the compact summary', () => {
  const cm = new ConversationManager({ keepRecent: 3 });
  for (let i = 1; i <= 6; i++) {
    cm.addTurn({ turnId: `T${i}`, question: `question ${i}`, answer: `answer ${i}` });
  }
  assert.ok(cm.recent.length <= 3);
  assert.ok(cm.summaries.length >= 1);
});

test('compileContextForPrompt includes recent Q&A + summary', () => {
  const cm = new ConversationManager({ keepRecent: 2 });
  cm.addTurn({ turnId: 'T1', question: 'old q', answer: 'old a' });
  cm.addTurn({ turnId: 'T2', question: 'recent q', answer: 'recent a' });
  const ctx = cm.compileContextForPrompt();
  assert.ok(ctx.includes('recent q'));
  assert.ok(ctx.includes('recent a'));
});

test('summary merging respects the char budget', () => {
  const cm = new ConversationManager({ keepRecent: 2, maxSummaryChars: 200 });
  for (let i = 1; i <= 8; i++) {
    cm.addTurn({ turnId: `T${i}`, question: `What is thing number ${i} in a long interview context line?`, answer: 'A fairly detailed answer repeated for the char budget test.' });
  }
  const totalChars = cm.summaries.reduce((a, s) => a + s.length, 0);
  assert.ok(totalChars <= 200);
});

test('history grows monotonically per turn with status metadata', () => {
  const cm = new ConversationManager({ keepRecent: 10 });
  cm.addTurn({ turnId: 'T1', question: 'eager question', answer: 'eager answer', status: 'eager' });
  const t = cm.recent[0];
  assert.strictEqual(t.from, 'eager');
  assert.strictEqual(t.turnId, 'T1');
});

test('reset clears all state', () => {
  const cm = new ConversationManager();
  cm.addTurn({ turnId: 'T1', question: 'q', answer: 'a' });
  cm.reset();
  assert.strictEqual(cm.totalTurns, 0);
  assert.strictEqual(cm.recent.length, 0);
  assert.strictEqual(cm.summaries.length, 0);
});

test('empty conversations produce an empty context string', () => {
  const cm = new ConversationManager();
  assert.strictEqual(cm.compileContextForPrompt(), '');
});

test('compileContextForPrompt returns the NEWEST turns first', () => {
  const cm = new ConversationManager({ keepRecent: 2 });
  for (let i = 1; i <= 6; i++) {
    cm.addTurn({ turnId: `T${i}`, question: `q${i}`, answer: `a${i}` });
  }
  const ctx = cm.compileContextForPrompt();
  assert.ok(ctx.includes('q6'), 'newest turn must be included');
  assert.ok(ctx.indexOf('q6') < ctx.indexOf('q5'), 'newest must precede older recents');
  assert.ok(ctx.includes('a6'));
  assert.ok(ctx.includes('Earlier in this interview'), 'overflow must land in the summary');
});

test('getContext returns the newest keepRecent turns (not the oldest)', () => {
  const cm = new ConversationManager({ keepRecent: 3 });
  for (let i = 1; i <= 5; i++) {
    cm.addTurn({ turnId: `T${i}`, question: `q${i}`, answer: `a${i}` });
  }
  const ctx = cm.getContext();
  assert.strictEqual(ctx.recent.length, 3);
  assert.strictEqual(ctx.recent[0].question, 'q3');
  assert.strictEqual(ctx.recent[ctx.recent.length - 1].question, 'q5');
});