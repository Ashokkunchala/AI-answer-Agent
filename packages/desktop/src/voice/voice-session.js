const { classifyVoiceText } = require('./voice-intent');

class VoiceSession {
  constructor({ onIntent = () => {}, onTranscript = () => {}, onError = () => {} } = {}) {
    this.active = false;
    this.onIntent = onIntent;
    this.onTranscript = onTranscript;
    this.onError = onError;
    this.lastTranscript = '';
  }

  start() {
    this.active = true;
  }

  stop() {
    this.active = false;
  }

  handlePartial(text) {
    if (!this.active) return;
    this.lastTranscript = String(text || '');
    this.onTranscript({ type: 'partial', text: this.lastTranscript });
  }

  handleFinal(text) {
    if (!this.active) return;
    const normalized = String(text || '').trim();
    if (!normalized) return;
    this.lastTranscript = normalized;
    const intent = classifyVoiceText(normalized);
    this.onTranscript({ type: 'final', text: normalized });
    this.onIntent(intent);
  }
}

module.exports = { VoiceSession };
