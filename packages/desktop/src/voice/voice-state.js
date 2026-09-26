const STATES = Object.freeze({
  IDLE: 'idle',
  LISTENING: 'listening',
  SPEECH_DETECTED: 'speech_detected',
  TRANSCRIBING: 'transcribing',
  THINKING: 'thinking',
  RESPONDING: 'responding',
  INTERRUPTED: 'interrupted',
  ERROR: 'error'
});

const TRANSITIONS = {
  [STATES.IDLE]: [STATES.LISTENING, STATES.ERROR],
  [STATES.LISTENING]: [STATES.SPEECH_DETECTED, STATES.IDLE, STATES.ERROR],
  [STATES.SPEECH_DETECTED]: [STATES.TRANSCRIBING, STATES.LISTENING, STATES.ERROR],
  [STATES.TRANSCRIBING]: [STATES.THINKING, STATES.LISTENING, STATES.ERROR],
  [STATES.THINKING]: [STATES.RESPONDING, STATES.INTERRUPTED, STATES.ERROR],
  [STATES.RESPONDING]: [STATES.INTERRUPTED, STATES.LISTENING, STATES.IDLE, STATES.ERROR],
  [STATES.INTERRUPTED]: [STATES.LISTENING, STATES.THINKING, STATES.ERROR],
  [STATES.ERROR]: [STATES.IDLE, STATES.LISTENING]
};

class VoiceStateMachine {
  constructor(onChange = () => {}) {
    this.state = STATES.IDLE;
    this.onChange = onChange;
  }

  canTransition(next) {
    return TRANSITIONS[this.state]?.includes(next) ?? false;
  }

  transition(next, metadata = {}) {
    if (next === this.state) return this.state;
    if (!this.canTransition(next)) {
      throw new Error(`Invalid voice transition: ${this.state} -> ${next}`);
    }
    const previous = this.state;
    this.state = next;
    this.onChange({ previous, state: next, ...metadata });
    return next;
  }

  reset() {
    this.state = STATES.IDLE;
  }
}

module.exports = { STATES, VoiceStateMachine };
