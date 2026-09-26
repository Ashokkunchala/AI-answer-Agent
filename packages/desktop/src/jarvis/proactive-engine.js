export class ProactiveEngine {
  constructor({ personality, onSuggestion } = {}) {
    this.personality = personality;
    this.onSuggestion = typeof onSuggestion === 'function' ? onSuggestion : () => {};
  }

  suggest({ event, context = {} } = {}) {
    if (!this.personality?.get?.().proactive) return null;
    if (!event) return null;
    const suggestion = { event: String(event).slice(0, 200), context, at: new Date().toISOString() };
    this.onSuggestion(suggestion);
    return suggestion;
  }
}
