export class ReminderManager {
  constructor() {
    this.timers = new Map();
  }

  schedule({ id = crypto.randomUUID(), delayMs, message }) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 7 * 24 * 60 * 60 * 1000) throw new Error('Invalid reminder delay');
    const timer = setTimeout(() => this.timers.delete(id), delayMs);
    this.timers.set(id, { timer, message: String(message || '').slice(0, 500), createdAt: Date.now() });
    return id;
  }

  cancel(id) {
    const reminder = this.timers.get(id);
    if (!reminder) return false;
    clearTimeout(reminder.timer);
    this.timers.delete(id);
    return true;
  }

  clear() {
    for (const id of this.timers.keys()) this.cancel(id);
  }
}
