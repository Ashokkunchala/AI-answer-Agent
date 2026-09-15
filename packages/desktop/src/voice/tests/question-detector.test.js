'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detectQuestion } = require('../question-detector');

test('ends with question mark is a question', () => {
  assert.strictEqual(detectQuestion('What is your greatest strength?').isQuestion, true);
});

test('wh- interrogative without a question mark is detected', () => {
  assert.strictEqual(detectQuestion('How do you manage AWS IAM policies').isQuestion, true);
});

test('yes/no starter is a question', () => {
  assert.strictEqual(detectQuestion('Can you walk me through your CI/CD pipeline').isQuestion, true);
});

test('command verbs like explain/tell are questions to the agent', () => {
  assert.strictEqual(detectQuestion('Tell me about your experience with Kubernetes').isQuestion, true);
});

test('comparison questions are questions', () => {
  assert.strictEqual(detectQuestion('What is the difference between Docker and Kubernetes?').isQuestion, true);
});

test('plain statements are not questions', () => {
  assert.strictEqual(detectQuestion('I worked at Acme for five years').isQuestion, false);
  assert.strictEqual(detectQuestion('The project used React and Node').isQuestion, false);
  assert.strictEqual(detectQuestion('Sure, that sounds good').isQuestion, false);
});

test('very short input is not a question', () => {
  assert.strictEqual(detectQuestion('hi').isQuestion, false);
  assert.strictEqual(detectQuestion('').isQuestion, false);
});

test('normalization strips trailing punctuation', () => {
  const { normalize } = require('../question-detector');
  assert.strictEqual(normalize('What is AWS?'), 'what is aws');
  assert.strictEqual(normalize("What's your name?"), 'whats your name');
});