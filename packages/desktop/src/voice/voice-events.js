const EVENTS = Object.freeze({
  READY: 'voice.ready',
  LISTENING: 'voice.listening',
  SPEECH_START: 'voice.speech_start',
  SPEECH_END: 'voice.speech_end',
  PARTIAL: 'voice.partial',
  FINAL: 'voice.final',
  COMMAND: 'voice.command',
  THINKING: 'voice.thinking',
  RESPONSE: 'voice.response',
  TTS_START: 'voice.tts_start',
  TTS_END: 'voice.tts_end',
  INTERRUPTED: 'voice.interrupted',
  ERROR: 'voice.error'
});

module.exports = { EVENTS };
