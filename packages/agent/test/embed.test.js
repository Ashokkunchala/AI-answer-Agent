import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgent } from '../src/core/embed.js';
import { ConfigLoader } from '../src/config/loader.js';

// Persist into a throwaway directory so tests never write the real project
// config (a prior version could clobber <cwd>/.agent/config.json).
const tempCwd = mkdtempSync(path.join(os.tmpdir(), 'agent-embed-test-'));
const testConfigLoader = new ConfigLoader({ cwd: tempCwd });

function fakeClient() {
  return {
    setConfig() {},
    async chat() {
      return { choices: [{ message: { role: 'assistant', content: 'hello from agent' }, finish_reason: 'stop' }] };
    },
    async *streamChat() {
      yield { choices: [{ delta: { content: 'hello from agent' }, finish_reason: 'stop' }] };
    },
    async models() {
      return [{ id: 'm1', name: 'Model One' }];
    },
    async health() {
      return { ok: true, status: 200 };
    },
  };
}

function memoryStore() {
  return {
    async save() {},
    async load() {
      return null;
    },
    async list() {
      return [];
    },
    async remove() {
      return false;
    },
    async fork() {
      return null;
    },
  };
}

const baseConfig = {
  workerUrl: 'http://127.0.0.1:8787',
  model: 'auto',
  tools: true,
  streaming: false,
  autoCheck: false,
  permissionMode: 'ask',
};

test('createAgent wires a usable in-process session and streams events', async () => {
  const session = await createAgent({ cwd: tempCwd, config: { ...baseConfig }, client: fakeClient(), sessionStore: memoryStore(), configLoader: testConfigLoader });

  const events = [];
  session.on('event', (event) => events.push(event));

  const out = await session.chat('hi');
  assert.equal(out, "Hi! I'm here. What would you like to work on?");
  assert.ok(events.some((e) => e.type === 'content'), 'emits content events');
  assert.ok(events.some((e) => e.type === 'done'), 'emits a done event');
});

test('session lifecycle: newSession, permission mode, models', async () => {
  const session = await createAgent({ cwd: tempCwd, config: { ...baseConfig }, client: fakeClient(), sessionStore: memoryStore(), configLoader: testConfigLoader });

  const first = session.sessionId;
  const second = session.newSession();
  assert.notEqual(first, second);

  assert.equal(await session.setPermissionMode('allow'), 'allow');
  assert.equal(session.permissionMode(), 'allow');
  await assert.rejects(() => session.setPermissionMode('bogus'), /Unknown permission mode/);

  const models = await session.models();
  assert.equal(models[0].id, 'm1');

  const tools = session.tools();
  assert.ok(Array.isArray(tools) && tools.length > 0, 'exposes tool list');
});
