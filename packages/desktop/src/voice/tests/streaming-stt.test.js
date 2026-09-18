'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseFluxMessage, StreamingSTT } = require('../streaming-stt');

function msg(obj) {
  return JSON.stringify(obj);
}

test('parses StartOfTurn', () => {
  const ev = parseFluxMessage(msg({
    type: 'TurnInfo',
    event: 'StartOfTurn',
    turn_index: 0,
    sequence_id: 123,
    transcript: 'hello',
  }));
  assert.strictEqual(ev.kind, 'start');
  assert.strictEqual(ev.turnIndex, 0);
  assert.strictEqual(ev.sequenceId, 123);
  assert.strictEqual(ev.transcript, 'hello');
});

test('parses Update with full-turn transcript', () => {
  const ev = parseFluxMessage(msg({
    type: 'TurnInfo',
    event: 'Update',
    turn_index: 0,
    sequence_id: 124,
    transcript: 'hello there',
    words: [{ word: 'hello' }],
  }));
  assert.strictEqual(ev.kind, 'update');
  assert.strictEqual(ev.transcript, 'hello there');
  assert.ok(Array.isArray(ev.words));
});

test('parses EagerEndOfTurn with confidence', () => {
  const ev = parseFluxMessage(msg({
    type: 'TurnInfo',
    event: 'EagerEndOfTurn',
    turn_index: 1,
    sequence_id: 200,
    transcript: 'eager draft',
    end_of_turn_confidence: 0.62,
  }));
  assert.strictEqual(ev.kind, 'eager-end');
  assert.strictEqual(ev.endOfTurnConfidence, 0.62);
});

test('parses TurnResumed', () => {
  const ev = parseFluxMessage(msg({ type: 'TurnInfo', event: 'TurnResumed', turn_index: 1, transcript: 'resumed text' }));
  assert.strictEqual(ev.kind, 'turn-resumed');
  assert.strictEqual(ev.transcript, 'resumed text');
});

test('parses EndOfTurn with trigger', () => {
  const ev = parseFluxMessage(msg({
    type: 'TurnInfo',
    event: 'EndOfTurn',
    turn_index: 2,
    sequence_id: 300,
    transcript: 'final text',
    trigger: 'model',
  }));
  assert.strictEqual(ev.kind, 'final');
  assert.strictEqual(ev.trigger, 'model');
});

test('parses Connected, ConfigureFailure and Error control messages', () => {
  assert.strictEqual(parseFluxMessage(msg({ type: 'Connected' })).kind, 'connected');
  const cfg = parseFluxMessage(msg({ type: 'ConfigureFailure', code: 'INVALID_THRESHOLD', description: 'bad threshold' }));
  assert.strictEqual(cfg.kind, 'configure-failure');
  assert.strictEqual(cfg.code, 'INVALID_THRESHOLD');
  assert.strictEqual(cfg.message, 'bad threshold');
  const err = parseFluxMessage(msg({ type: 'Error', code: 'DG_ERROR', description: 'boom' }));
  assert.strictEqual(err.kind, 'error');
  assert.strictEqual(err.code, 'DG_ERROR');
  assert.strictEqual(err.message, 'boom');
});

test('returns null for non-transcript messages', () => {
  assert.strictEqual(parseFluxMessage(msg({ type: 'Metadata', transaction_id: 'x' })), null);
  assert.strictEqual(parseFluxMessage('not json'), null);
  assert.strictEqual(parseFluxMessage(msg({ type: 'SomethingUnknown' })), null);
});

test('chunkBytes defaults to ~80ms frames at the configured sample rate (no NaN)', () => {
  const stt = new StreamingSTT({ apiKey: 'x', log: () => {} });
  assert.ok(Number.isFinite(stt.chunkBytes), 'chunkBytes must not be NaN');
  const expected = Math.round((16000 * 80) / 1000) * 2;
  assert.strictEqual(stt.chunkBytes, expected);
});

test('connect without an API key reports NO_API_KEY and emits error', () => {
  const stt = new StreamingSTT({ apiKey: '', log: () => {} });
  const errors = [];
  stt.on('error', (e) => errors.push(e));
  const res = stt.connect();
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'no-api-key');
  assert.strictEqual(stt.snapshot().provider, 'deepgram-flux');
  assert.strictEqual(stt.snapshot().api, 'v2');
  assert.strictEqual(stt.snapshot().model, 'flux-general-en');
  assert.strictEqual(errors[0].code, 'NO_API_KEY');
});

test('sendAudio buffers while disconnected instead of dropping (no throw)', () => {
  const stt = new StreamingSTT({ apiKey: 'x', log: () => {} });
  const buf = Buffer.alloc(640);
  const ok = stt.sendAudio(buf);
  assert.strictEqual(ok, true);
  assert.strictEqual(stt._preConnectBuffer.length, 1);
  assert.strictEqual(stt._preConnectBytes, 640);
  stt._teardown();
});

test('pre-connect buffer is bounded (oldest frames dropped)', () => {
  const stt = new StreamingSTT({ apiKey: 'x', maxPreConnectBytes: 640, log: () => {} });
  stt.sendAudio(Buffer.alloc(640));
  stt.sendAudio(Buffer.alloc(640));
  assert.strictEqual(stt._preConnectBuffer.length, 1);
  assert.strictEqual(stt._preConnectBytes, 640);
  assert.strictEqual(stt.preConnectDropped, 1);
  stt._teardown();
});

test('buffered frames flush once the socket opens', () => {
  let sentBytes = 0;
  let handlers = {};
  class FakeWS {
    constructor() { handlers = {}; }
    on(ev, cb) { handlers[ev] = cb; }
    send(d) { sentBytes += d.length || 0; }
    ping() {}
    removeAllListeners() {}
    terminate() {}
    set readyState(_) {} get readyState() { return 1; }
  }
  try {
    const stt = new StreamingSTT({ apiKey: 'x', chunkBytes: 1280, log: () => {}, ws: FakeWS });
    stt.sendAudio(Buffer.alloc(640));
    stt.sendAudio(Buffer.alloc(640));
    assert.strictEqual(stt._preConnectBuffer.length, 2);
    const res = stt.connect();
    assert.strictEqual(res.ok, true);
    handlers.open();
    assert.strictEqual(stt.connected, true);
    // Flux audio is held until ConfigureSuccess, not merely socket open.
    assert.strictEqual(stt._preConnectBuffer.length, 2, 'buffer retained until ConfigureSuccess');
    handlers.message(Buffer.from(JSON.stringify({ type: 'ConfigureSuccess' })));
    assert.strictEqual(stt._configured, true);
    assert.strictEqual(stt._preConnectBuffer.length, 0, 'buffer flushed after ConfigureSuccess');
    assert.strictEqual(sentBytes >= 1280, true, 'buffered chunks sent after configuration');
    stt._teardown();
  } finally {
    // ignore
  }
});

test('sendAudio returns true when connected', () => {
  const stt = new StreamingSTT({ apiKey: 'x', log: () => {} });
  stt._ws = { send: () => {}, readyState: 1 };
  stt.connected = true;
  stt.chunkBytes = 640;
  const ok = stt.sendAudio(Buffer.alloc(640));
  assert.strictEqual(ok, true);
  stt._teardown();
});

test('keepalive is armed with the configured idle interval', () => {
  const stt = new StreamingSTT({ apiKey: 'x', log: () => {} });
  assert.strictEqual(stt.keepaliveMs, 8000);
  const stt2 = new StreamingSTT({ apiKey: 'x', log: () => {}, keepaliveMs: 5000 });
  assert.strictEqual(stt2.keepaliveMs, 5000);
  stt2._ws = { send: () => {}, ping: () => {}, readyState: 1 };
  stt2.connected = true;
  const before = stt2._lastSentAt;
  stt2.sendAudio(Buffer.alloc(stt2.chunkBytes));
  assert.ok(stt2._lastSentAt >= before, 'sending audio must refresh the idle clock');
  stt2._teardown();
  assert.strictEqual(stt2._keepaliveTimer, null);
});