const MIN_STABLE_CHARS = 12;
const SILENCE_MS = 650;

export class StableTranscriptDetector {
  constructor({ silenceMs = SILENCE_MS, minChars = MIN_STABLE_CHARS } = {}) {
    this.silenceMs = silenceMs;
    this.minChars = minChars;
    this.current = '';
    this.lastChangedAt = 0;
    this.lastEmitted = '';
  }

  push(text, now = Date.now()) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized || normalized === this.current) return null;
    this.current = normalized;
    this.lastChangedAt = now;
    return { type: 'partial', text: normalized };
  }

  flush(now = Date.now(), force = false) {
    if (!this.current || this.current.length < this.minChars) return null;
    if (!force && now - this.lastChangedAt < this.silenceMs) return null;
    if (this.current === this.lastEmitted) return null;
    this.lastEmitted = this.current;
    return { type: 'stable', text: this.current };
  }

  reset() {
    this.current = '';
    this.lastChangedAt = 0;
    this.lastEmitted = '';
  }
}
