'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { AiClient, parseSSE } = require('../ai-client');

const BASE = 'https://workers.test.example';

function sseResponse(model, texts) {
  const enc = new TextEncoder();
  const frames = texts.map((t) => {
    const chunk = {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      model,
      choices: [{ index: 0, delta: { content: t }, finish_reason: null }],
    };
    return enc.encode('data: ' + JSON.stringify(chunk) + '\n\n');
  });
  frames.push(enc.encode('data: [DONE]\n\n'));
  let i = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (i < frames.length) c.enqueue(frames[i++]);
      else c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installFetch(handler) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), init };
    calls.push(entry);
    return handler(entry, calls);
  };
  return { calls, restore: () => { globalThis.fetch = prev; } };
}

test('parseSSE resolves text and the streamed model', async () => {
  const { text, model } = await parseSSE(sseResponse('llama-3.3-70b', ['a', 'b', 'c']).body, () => {});
  assert.strictEqual(text, 'abc');
  assert.strictEqual(model, 'llama-3.3-70b');
});

test('learns the actually-used model and cooldowns the requested one after a mismatch', async () => {
  const { calls, restore } = installFetch((entry) => sseResponse('llama-3.3-70b', ['Docker and Kubernetes', ' differ.']));
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'gemini-3.1-flash-lite', log: () => {} });
    await ai.streamAnswer({ transcript: 'q1' });
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'gemini-3.1-flash-lite');

    // Second answer must skip the cooldown'd gemini and use the learned model.
    await ai.streamAnswer({ transcript: 'q2' });
    assert.strictEqual(JSON.parse(calls[1].init.body).model, 'llama-3.3-70b');

    await ai.streamAnswer({ transcript: 'q3' });
    assert.strictEqual(JSON.parse(calls[2].init.body).model, 'llama-3.3-70b');
  } finally {
    restore();
  }
});

test('cooldowns the requested model on a credit/quota failure and falls back to auto', async () => {
  const { calls, restore } = installFetch((entry) => {
    if (calls.length === 1) {
      return jsonResponse(500, { error: '2021: Insufficient AI Gateway credits' });
    }
    return sseResponse('llama-3.3-70b', ['ok', ' now']);
  });
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'gemini-3.1-flash-lite', log: () => {} });
    await assert.rejects(() => ai.streamAnswer({ transcript: 'boom' }), /Insufficient/);
    const content = await ai.streamAnswer({ transcript: 'retry' });
    assert.strictEqual(content, 'ok now');
    // No good model learned yet -> auto routes the retry.
    assert.strictEqual(JSON.parse(calls[1].init.body).model, 'auto');
  } finally {
    restore();
  }
});

test('does not cooldown when the worker uses the requested model', async () => {
  const { calls, restore } = installFetch((entry) => sseResponse('gemini-3.1-flash-lite', ['fine']));
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'gemini-3.1-flash-lite', log: () => {} });
    await ai.streamAnswer({ transcript: 'q1' });
    await ai.streamAnswer({ transcript: 'q2' });
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'gemini-3.1-flash-lite');
    assert.strictEqual(JSON.parse(calls[1].init.body).model, 'gemini-3.1-flash-lite');
  } finally {
    restore();
  }
});

test('uses auto first, then the learned model explicitly (fast path)', async () => {
  const { calls, restore } = installFetch((entry) => sseResponse('llama-3.3-70b', ['auto', ' routed']));
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'auto', log: () => {} });
    await ai.streamAnswer({ transcript: 'q1' });
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'auto');
    // From the second call on, the learned good model is sent explicitly.
    await ai.streamAnswer({ transcript: 'q2' });
    assert.strictEqual(JSON.parse(calls[1].init.body).model, 'llama-3.3-70b');
    await ai.streamAnswer({ transcript: 'q3' });
    assert.strictEqual(JSON.parse(calls[2].init.body).model, 'llama-3.3-70b');
  } finally {
    restore();
  }
});

test('restores the persisted learned model from cache (skips the auto probe)', async () => {
  const cacheFile = require('node:os').tmpdir() + '/aict-model-cache-' + Date.now() + '.json';
  const { calls, restore } = installFetch((entry) => sseResponse('llama-3.3-70b', ['d', 'e']));
  try {
    const ai1 = new AiClient({ defaultWorkerUrl: BASE, model: 'auto', modelCacheFile: cacheFile, log: () => {} });
    await ai1.streamAnswer({ transcript: 'q1' });
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'auto');

    const ai2 = new AiClient({ defaultWorkerUrl: BASE, model: 'auto', modelCacheFile: cacheFile, log: () => {} });
    await ai2.streamAnswer({ transcript: 'q1' });
    // Restored from cache → straight to the known-good explicit model.
    assert.strictEqual(JSON.parse(calls[1].init.body).model, 'llama-3.3-70b');
  } finally {
    restore();
    try { require('node:fs').unlinkSync(cacheFile); } catch (_) { /* */ }
  }
});

test('does not restore a stale expired cache entry', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const cacheFile = os.tmpdir() + '/aict-old-cache-' + Date.now() + '.json';
  fs.writeFileSync(cacheFile, JSON.stringify({ model: 'llama-3.3-70b', at: Date.now() - 999 * 60 * 1000 }));
  const { calls, restore } = installFetch((entry) => sseResponse('llama-3.3-70b', ['d', 'e']));
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'auto', modelCacheFile: cacheFile, modelCacheTtlMs: 60 * 60 * 1000, log: () => {} });
    await ai.streamAnswer({ transcript: 'q1' });
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'auto');
  } finally {
    restore();
    try { fs.unlinkSync(cacheFile); } catch (_) { /* */ }
  }
});

test('cooldown is disabled when modelCooldownMs is 0', async () => {
  const { calls, restore } = installFetch((entry) => sseResponse('llama-3.3-70b', ['d', 'e']));
  try {
    const ai = new AiClient({ defaultWorkerUrl: BASE, model: 'gemini-3.1-flash-lite', modelCooldownMs: 0, log: () => {} });
    await ai.streamAnswer({ transcript: 'q1' });
    await ai.streamAnswer({ transcript: 'q2' });
    // No cooldown => always sends the configured model.
    for (const c of calls) assert.strictEqual(JSON.parse(c.init.body).model, 'gemini-3.1-flash-lite');
  } finally {
    restore();
  }
});