export class CommandHistory {
  constructor({ maxEntries = 100 } = {}) {
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  add({ command, source = 'voice', ok = true, durationMs = 0 } = {}) {
    const entry = {
      command: String(command || '').slice(0, 500),
      source,
      ok: Boolean(ok),
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
      at: new Date().toISOString(),
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    return entry;
  }

  list(limit = this.maxEntries) {
    return this.entries.slice(-Math.max(1, Math.min(limit, this.maxEntries)));
  }

  clear() {
    this.entries.length = 0;
  }
}
