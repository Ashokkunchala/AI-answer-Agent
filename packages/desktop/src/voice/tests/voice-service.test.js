'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { VoiceService, PHASE } = require('../voice-service');

function fakeDeps(opts = {}) {
  const capture = {
    start: () => (opts.startOk === false ? { ok: false, error: opts.error || 'no-device' } : { ok: true }),
    stop: () => {},
    isCapturing: opts.startOk === false ? false : opts.isCapturing !== undefined ? opts.isCapturing : true,
    removeAllListeners: () => {},
    on: () => {},
    snapshot: () => ({}),
    pushMicPcm: () => {},
    switchSource: () => ({ ok: true }),
  };
  const stt = {
    startSession: () => {},
    on: () => {},
    removeAllListeners: () => {},
    stopSession: () => {},
    isConnected: true,
    snapshot: () => ({}),
    sendAudio: () => true,
    flushSend: () => {},
  };
  const aiStream = opts.aiStream || [];
  const aiCancel = opts.aiCancel || [];
  const ai = {
    warmup: async () => ({ ok: true }),
    warm: true,
    cancel: () => { aiCancel.push('cancel'); },
    streamAnswer: async (payload) => { aiStream.push(payload); return 'answer'; },
    removeAllListeners: () => {},
    once: () => {},
    on: () => {},
  };
  const deviceManager = {
    start: async () => {},
    refresh: async () => {},
    getDevices: () => [],
    snapshot: () => ({}),
  };
  return { capture, stt, ai, deviceManager };
}

function makeService(opts = {}) {
  const deps = fakeDeps(opts);
  return {
    svc: new VoiceService({
      config: Object.assign({ log: () => {} }, opts.config || {}),
      deps,
      emitToRenderer: () => {},
    }),
    deps,
  };
}

test('start() reports ok:false when capture cannot start', async () => {
  const { svc } = makeService({ startOk: false });
  const res = await svc.start();
  assert.strictEqual(res.ok, false);
  assert.ok(res.error);
  // Not ready (capture down) so the phase stays at the error state.
  assert.strictEqual(svc.phase, PHASE.ERROR);
  assert.strictEqual(svc._ready, false);
});

test('start() does not fire a speculative AI generation during startup', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  const res = await svc.start();
  assert.strictEqual(res.ok, true);
  assert.strictEqual(aiStream.length, 0, 'startup must not consume an AI generation');
  await svc.stop();
});

test('start() reports ok:true when capture starts', async () => {
  const { svc } = makeService({});
  const res = await svc.start();
  assert.strictEqual(res.ok, true);
  // STT + capture + AI all warm → ready transitions to LISTENING.
  assert.strictEqual(svc.phase, PHASE.LISTENING);
});

test('stop() clears per-session state so a restart begins clean', async () => {
  const { svc } = makeService({});
  svc._ready = true;
  svc._sttConnectedEver = true;
  svc._restartAttempts = 3;
  svc._gateOpen = true;
  svc._ask = { turnId: 'T1', active: true };
  svc._firstPartialPerTurn.add(42);
  await svc.stop();
  assert.strictEqual(svc._ready, false);
  assert.strictEqual(svc._sttConnectedEver, false);
  assert.strictEqual(svc._restartAttempts, 0);
  assert.strictEqual(svc._gateOpen, false);
  assert.strictEqual(svc._ask, null);
  assert.strictEqual(svc._firstPartialPerTurn.size, 0);
});

const startEvt = (turnIndex, sequenceId) => ({
  kind: 'start', turnIndex, sequenceId, transcript: '',
});

const eagerEvt = (transcript, turnIndex, sequenceId, confidence = 0.9) => ({
  kind: 'eager-end', turnIndex, sequenceId, transcript, endOfTurnConfidence: confidence,
});

const finalEvt = (transcript, turnIndex, sequenceId, trigger = 'model') => ({
  kind: 'final', turnIndex, sequenceId, transcript, trigger,
});

test('eager draft starts the answer; a corrected final before first token restarts it once', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  const res = await svc.start();
  assert.strictEqual(res.ok, true);
  try {
    svc.turnMan.onFlux(startEvt(1, 10));
    svc.turnMan.onFlux(eagerEvt('What is Dokr?', 1, 11));
    assert.strictEqual(aiStream.length, 1, 'eager draft should start the answer');
    assert.strictEqual(aiStream[0].transcript, 'What is Dokr?');

    svc.turnMan.onFlux(finalEvt('What is Docker?', 1, 12));
    assert.strictEqual(aiCancel.length, 1, 'stale draft answer should be cancelled');
    assert.strictEqual(aiStream.length, 2, 'corrected final should restart the answer');
    assert.strictEqual(aiStream[1].transcript, 'What is Docker?');
    assert.strictEqual(svc.questionCount, 1, 'restart must not double-count the question');
  } finally {
    await svc.stop();
  }
});

test('identical final transcript does not restart the eager answer', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 20));
    svc.turnMan.onFlux(eagerEvt('What is Docker?', 1, 21));
    svc.turnMan.onFlux(finalEvt('What is Docker?', 1, 22));
    assert.strictEqual(aiStream.length, 1);
    assert.strictEqual(aiCancel.length, 0);
  } finally {
    await svc.stop();
  }
});

test('a substantive non-question final is still answered like chat', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 30));
    svc.turnMan.onFlux(finalEvt('Docker is a container platform.', 1, 32));
    assert.strictEqual(aiStream.length, 1, 'voice should answer substantive speech even without question punctuation');
    assert.strictEqual(aiStream[0].transcript, 'Docker is a container platform.');
    assert.strictEqual(aiCancel.length, 0);
  } finally {
    await svc.stop();
  }
});

const updateEvt = (transcript, turnIndex, sequenceId) => ({
  kind: 'update', turnIndex, sequenceId, transcript,
});

test('a confident partial starts the answer before the final arrives', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 40));
    // Partial that already reads as a question (>= partialMinLength and
    // confidence >= partialQuestionThreshold).
    svc.turnMan.onFlux(updateEvt('What is the difference between Docker and Kubernetes?', 1, 41));
    assert.strictEqual(aiStream.length, 1, 'confident partial should start the answer early');
    assert.strictEqual(aiStream[0].transcript, 'What is the difference between Docker and Kubernetes?');
    assert.strictEqual(svc._ask && svc._ask.viaPartial, true, 'answer flagged as partial-started');
    // Finalizing the same turn with an identical transcript must not restart.
    svc.turnMan.onFlux(finalEvt('What is the difference between Docker and Kubernetes?', 1, 42));
    assert.strictEqual(aiStream.length, 1, 'identical final must not restart an early answer');
    assert.strictEqual(aiCancel.length, 0);
  } finally {
    await svc.stop();
  }
});

test('partial early answer is restarted once with a corrected final', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 50));
    svc.turnMan.onFlux(updateEvt('What is the difference between Dokr?', 1, 51));
    assert.strictEqual(aiStream.length, 1);
    assert.strictEqual(svc._ask && svc._ask.viaPartial, true);
    // Before first token, a more complete final replaces the stale draft once.
    svc.turnMan.onFlux(finalEvt('What is the difference between Docker and Kubernetes?', 1, 52));
    assert.strictEqual(aiCancel.length, 1, 'stale partial answer cancelled');
    assert.strictEqual(aiStream.length, 2, 'corrected final restarts the answer');
    assert.strictEqual(aiStream[1].transcript, 'What is the difference between Docker and Kubernetes?');
    assert.strictEqual(svc.questionCount, 1, 'restart must not double-count the question');
  } finally {
    await svc.stop();
  }
});

test('short or non-question partials do not fire an early answer', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 60));
    svc.turnMan.onFlux(updateEvt('What is', 1, 61));            // too short + below threshold wording
    svc.turnMan.onFlux(updateEvt('The meeting is at noon today', 1, 62)); // statement
    assert.strictEqual(aiStream.length, 0, 'no early answer for weak/statement partials');
  } finally {
    await svc.stop();
  }
});

test('early partial answer can be disabled via config', async () => {
  const aiStream = [], aiCancel = [];
  const { svc } = makeService({ aiStream, aiCancel, config: { earlyAnswerOnPartial: false } });
  await svc.start();
  try {
    svc.turnMan.onFlux(startEvt(1, 70));
    svc.turnMan.onFlux(updateEvt('What is the difference between Docker and Kubernetes?', 1, 71));
    assert.strictEqual(aiStream.length, 0, 'partial early answers disabled');
    svc.turnMan.onFlux(finalEvt('What is the difference between Docker and Kubernetes?', 1, 72));
    assert.strictEqual(aiStream.length, 1, 'final still answers normally');
  } finally {
    await svc.stop();
  }
});