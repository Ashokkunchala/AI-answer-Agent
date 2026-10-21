import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

const encoder = new TextEncoder();

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeEnv({ allowAnonymous = false, production = true, adminToken = null, apiKeySecret = null } = {}) {
  const keyId = 'ktest123';
  const records = new Map();
  if (apiKeySecret) {
    records.set('key:' + keyId, {
      id: keyId, name: 'test-client', key_hash: await sha256Hex(apiKeySecret),
      revoked: false, tier: 'standard',
    });
  }
  return {
    ENVIRONMENT: production ? 'production' : 'development',
    ALLOW_ANONYMOUS: allowAnonymous ? 'true' : 'false',
    ADMIN_API_TOKEN: adminToken,
    API_KEYS: {
      async get(key) { return records.get(key) ?? null; },
      async put(key, value) { records.set(key, JSON.parse(value)); },
      async delete(key) { records.delete(key); },
      async list() { return { keys: [], list_complete: true }; },
    },
  };
}

async function call(path, { method = 'GET', token, body, headers = {} } = {}, env) {
  const requestHeaders = new Headers(headers);
  if (token) requestHeaders.set('Authorization', 'Bearer ' + token);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  const request = new Request('https://agent.test' + path, {
    method, headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return worker.fetch(request, env, { waitUntil() {} });
}

test('health endpoint remains public', async () => {
  const response = await call('/health', {}, await makeEnv());
  assert.equal(response.status, 200);
});

test('protected AI endpoints reject requests without credentials', async () => {
  const response = await call('/ask', { method: 'POST', body: { question: 'hello' } }, await makeEnv());
  assert.equal(response.status, 401);
});

test('production cannot enable anonymous access through the development flag', async () => {
  const response = await call('/ask', { method: 'POST', body: { question: 'hello' } },
    await makeEnv({ allowAnonymous: true, production: true }));
  assert.equal(response.status, 401);
});

test('API-key creation rejects unauthenticated requests', async () => {
  const response = await call('/v1/keys', { method: 'POST', body: { name: 'unexpected' } }, await makeEnv());
  assert.equal(response.status, 401);
});

test('a regular API key cannot create or administer other API keys', async () => {
  const secret = 'regular-client-secret';
  const env = await makeEnv({ apiKeySecret: secret });
  const token = 'dvops_ktest123_' + secret;
  const response = await call('/v1/keys', { method: 'POST', token, body: { name: 'unexpected' } }, env);
  assert.equal(response.status, 403);
});

test('voice WebSocket upgrades require authentication', async () => {
  const response = await call('/voice-socket', { headers: { Upgrade: 'websocket' } }, await makeEnv());
  assert.equal(response.status, 401);
});
