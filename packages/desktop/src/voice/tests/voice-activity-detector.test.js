'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { VoiceActivityDetector, State } = require('../voice-activity-detector');

const NS_20MS = BigInt(20 * 1e6);
const NS_100MS = BigInt(100 * 1e6);

function feedSpeech(vad, frames, startNs, step = NS_20MS) {
  let ns = startNs;
  for (let i = 0; i < frames; i++) {
    vad.process({ speech: true, level: 0.5, nowNs: ns });
    ns += step;
  }
  return ns;
}

function advance(vad, steps, startNs, step = NS_100MS) {
  let ns = startNs;
  for (let i = 0; i < steps; i++) {
    ns += step;
    vad.tick(ns);
  }
  return ns;
}

test('idle -> speaking on speech onset', () => {
  const vad = new VoiceActivityDetector({ minSpeechMs: 100 });
  feedSpeech(vad, 1, 0n);
  assert.strictEqual(vad.getState(), State.SPEAKING);
});

test('short blip is swallowed without an end event', () => {
  const ends = [];
  const vad = new VoiceActivityDetector({ minSpeechMs: 300, speechEndMs: 500 });
  vad.onSpeechEnd = (d) => ends.push(d);

  feedSpeech(vad, 2, 0n);            // ~40ms of speech
  advance(vad, 10, NS_20MS * 2n);    // +1000ms gap
  assert.strictEqual(ends.length, 0);
  assert.strictEqual(vad.getState(), State.IDLE);
});

test('long enough speech with a pause resumes and then ends via gap timer', () => {
  const ends = [];
  const vad = new VoiceActivityDetector({ pauseResumeMs: 300, speechEndMs: 700, minSpeechMs: 100 });
  vad.onSpeechEnd = (d) => ends.push(d);

  let ns = feedSpeech(vad, 10, 0n);                  // 200ms speech
  ns = advance(vad, 4, ns);                          // +400ms gap -> PAUSED
  assert.strictEqual(vad.getState(), State.PAUSED);

  ns = feedSpeech(vad, 1, ns);                       // resume -> SPEAKING
  assert.strictEqual(vad.getState(), State.SPEAKING);

  ns = advance(vad, 8, ns);                          // +800ms gap
  assert.strictEqual(vad.getState(), State.SPEECH_END);
  assert.strictEqual(ends.length, 1);
});

test('finalizing -> utterance final resets to idle', () => {
  const vad = new VoiceActivityDetector({ minSpeechMs: 100, speechEndMs: 300 });
  let ns = feedSpeech(vad, 10, 0n);
  ns = advance(vad, 4, ns);
  assert.strictEqual(vad.getState(), State.SPEECH_END);
  vad.finalizing();
  assert.strictEqual(vad.getState(), State.FINALIZING);
  vad.onUtteranceFinalized();
  assert.strictEqual(vad.getState(), State.IDLE);
});

test('speech during finalizing reopens the utterance', () => {
  const vad = new VoiceActivityDetector({ minSpeechMs: 100, speechEndMs: 300 });
  let ns = feedSpeech(vad, 10, 0n);
  ns = advance(vad, 4, ns);
  vad.finalizing();
  assert.strictEqual(vad.getState(), State.FINALIZING);
  feedSpeech(vad, 1, ns + NS_100MS * 3n);
  assert.strictEqual(vad.getState(), State.SPEAKING);
});

test('forced finalize timeout ends speech', () => {
  const ends = [];
  const vad = new VoiceActivityDetector({ minSpeechMs: 100, speechEndMs: 300, finalizeTimeoutMs: 500 });
  vad.onSpeechEnd = (d) => ends.push(d);
  let ns = feedSpeech(vad, 10, 0n);
  ns = advance(vad, 4, ns);
  vad.finalizing();
  ns = advance(vad, 6, ns);
  assert.strictEqual(vad.getState(), State.SPEECH_END);
  assert.strictEqual(ends.length, 2); // natural end + forced timeout end
});

test('error state is set and reset returns to idle', () => {
  const vad = new VoiceActivityDetector();
  vad.onError();
  assert.strictEqual(vad.getState(), State.ERROR);
  vad.reset();
  assert.strictEqual(vad.getState(), State.IDLE);
});