const VoiceService=require('./voice-service');
const VoiceSession=require('./voice-session');
const TTSService=require('./tts-service');
const EVENTS=require('./voice-events');
const {STATES}=require('./voice-state');
const {MODES,INTENTS,classifyVoiceIntent}=require('./voice-intent');
module.exports={VoiceService,VoiceSession,TTSService,EVENTS,STATES,MODES,INTENTS,classifyVoiceIntent};
