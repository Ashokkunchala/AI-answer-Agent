import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRetrievedContext, vectorizeAvailable } from './retrieval.js';

test('vectorize availability requires AI and VECTORIZE bindings', () => {
  assert.equal(vectorizeAvailable({}), false);
  assert.equal(vectorizeAvailable({ AI: {}, VECTORIZE: {} }), true);
});

test('retrieved context is compact and labeled', () => {
  const value = formatRetrievedContext([
    { id: '1', score: 0.91, metadata: { type: 'resume', text: 'Built AWS ECS deployments with Terraform.' } },
    { id: '2', score: 0.82, metadata: { type: 'job_description', text: 'Requires Kubernetes and CI/CD experience.' } },
  ]);
  assert.match(value, /resume/);
  assert.match(value, /AWS ECS/);
  assert.match(value, /job_description/);
});
