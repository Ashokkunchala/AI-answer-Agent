'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { AudioProcessingPipeline, SpeechClassifier } = require('../../audio/audio-processing-pipeline');

function silenceBlock(samples) {
  const b = Buffer.alloc(samples * 2);
  return b;
}

function toneBlock(samples, freq = 440, amp = 0.5, sampleRate = 48000) {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * amp;
    const v = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

test('pipeline frames silence into 320-sample 16kHz int16 buffers', () => {
  const p = new AudioProcessingPipeline({ inRate: 48000, channels: 1 });
  const frames = p.feed(silenceBlock(48000)); // 1 second
  assert.ok(frames.length > 0);

  const f = frames[0];
  assert.strictEqual(f.sampleRate, 16000);
  assert.ok(Buffer.isBuffer(f.pcm));
  // 320 int16 samples × 2 bytes per sample.
  assert.strictEqual(f.pcm.byteLength, 640);
  assert.strictEqual(f.vad, false);

  const allSilent = frames.every((x) => x.classifier === 'silence');
  assert.ok(allSilent);
});

test('loud sustained tone triggers speech VAD frames', () => {
  const p = new AudioProcessingPipeline({ inRate: 48000, channels: 1, vadThreshold: 0.02 });
  const frames = p.feed(toneBlock(48000));
  assert.ok(frames.some((f) => f.vad === true));
  assert.ok(frames.some((f) => f.speech !== undefined));
});

test('flush emits any partial frame', () => {
  const p = new AudioProcessingPipeline({ inRate: 48000, channels: 1 });
  // 0.9s leaves a partial frame after 1.0s would have produced none.
  const before = p.feed(silenceBlock(43200));
  const after = p.flush();
  const total = before.length + after.length;
  assert.ok(total >= 44 && total <= 46, 'expected ~45 frames got ' + total);
});

test('SpeechClassifier labels obvious and empty frames', () => {
  const cls = new SpeechClassifier({ sampleRate: 16000 });
  const zero = new Float64Array(320);
  const loud = new Float64Array(320).fill(0.4);

  const start0 = cls.classify(zero);
  assert.strictEqual(start0.state, 'silence');

  const louds = [];
  for (let i = 0; i < 6; i++) louds.push(cls.classify(loud));
  const last = louds[louds.length - 1];
  assert.strictEqual(last.state, 'speech');

  cls.reset();
  assert.strictEqual(cls.speechFrames, 0);
});