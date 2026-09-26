import test from 'node:test';
import assert from 'node:assert/strict';
import { StableTranscriptDetector } from './stable-transcript.js';

test('emits a stable transcript after silence', () => {
  const detector = new StableTranscriptDetector({ silenceMs: 100, minChars: 4 });
  detector.push('hello interviewer', 1000);
  assert.equal(detector.flush(1050), null);
  assert.deepEqual(detector.flush(1150), { type: 'stable', text: 'hello interviewer' });
});

test('does not emit the same stable transcript twice', () => {
  const detector = new StableTranscriptDetector({ silenceMs: 0, minChars: 4 });
  detector.push('tell me more', 1000);
  assert.ok(detector.flush(1000));
  assert.equal(detector.flush(1000), null);
});
