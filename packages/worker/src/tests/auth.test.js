import test from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, validateApiKey, timingSafeEqual } from '../auth.js';

class MemoryKV {
  constructor() {
    this.data = new Map();
  }

  async get(key, options = {}) {
    const value = this.data.get(key);
    if (value == null) return null;
    return options.type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.data.set(key, value);
  }
}

test('API keys validate against the stored hash', async () => {
  const kv = new MemoryKV();
  const generated = await generateKey();

  await kv.put('key:' + generated.id, JSON.stringify({
    id: generated.id,
    key_hash: generated.key_hash,
    revoked: false,
    expires_at: null,
    name: 'test',
  }));

  const env = { API_KEYS: kv };
  const validated = await validateApiKey(generated.key, env);

  assert.equal(validated.id, generated.id);
  assert.equal(await validateApiKey(generated.key + 'x', env), null);
});

test('revoked and expired API keys are rejected', async () => {
  const kv = new MemoryKV();
  const generated = await generateKey();
  const base = {
    id: generated.id,
    key_hash: generated.key_hash,
    name: 'test',
  };

  await kv.put('key:' + generated.id, JSON.stringify({ ...base, revoked: true, expires_at: null }));
  assert.equal(await validateApiKey(generated.key, { API_KEYS: kv }), null);

  const second = await generateKey();
  await kv.put('key:' + second.id, JSON.stringify({
    ...base,
    id: second.id,
    key_hash: second.key_hash,
    revoked: false,
    expires_at: '2000-01-01T00:00:00.000Z',
  }));
  assert.equal(await validateApiKey(second.key, { API_KEYS: kv }), null);
});

test('constant-time comparison rejects length and content mismatches', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
});
