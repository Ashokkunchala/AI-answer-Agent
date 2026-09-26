import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundedAnswer } from './answer-pipeline.js';

test('truncates answers that are too long for live spoken delivery', () => {
  const result = buildGroundedAnswer({
    question: 'Tell me about your AWS experience',
    answer: 'A'.repeat(2000),
    resume: 'AWS ECS Terraform Kubernetes',
    jobDesc: 'AWS DevOps engineer',
    taskType: 'interview',
  });
  assert.ok(result.answer.length <= 1200);
  assert.ok(result.guard_flags.includes('too_long_for_live_delivery'));
});

test('flags unsupported first-person experience claims', () => {
  const result = buildGroundedAnswer({
    question: 'What did you build?',
    answer: 'I built and deployed a massive production platform.',
    resume: 'Worked with Terraform and Docker.',
    jobDesc: '',
    taskType: 'technical',
  });
  assert.ok(result.guard_flags.includes('possible_unsupported_experience'));
  assert.equal(result.grounding, 'review');
});
