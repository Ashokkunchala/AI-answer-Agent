const { EventEmitter } = require('events');
const VoiceSession = require('./voice-session');
const { STATES } = require('./voice-state');
const { MODES, classifyVoiceIntent } = require('./voice-intent');
const EVENTS = require('./voice-events');

class VoiceService extends EventEmitter {
  constructor({ stt=null, tts=null, mode=MODES.INTERVIEW, onRequest=null }={}) { super(); this.stt=stt; this.tts=tts; this.session=new VoiceSession({mode}); this.onRequest=onRequest; }
  setMode(mode) { this.session.mode=mode; this.emit('mode',{mode}); }
  async start() { this.session.transition(STATES.LISTENING); this.emit(EVENTS.READY,{sessionId:this.session.sessionId,mode:this.session.mode}); this.emit(EVENTS.LISTENING,{mode:this.session.mode}); if(this.stt?.start) await this.stt.start(this.handlers()); }
  async stop() { if(this.stt?.stop) await this.stt.stop(); this.session.reset(); }
  handlers() { return { onSpeechStart:()=>this.emit(EVENTS.SPEECH_START), onSpeechEnd:()=>this.emit(EVENTS.SPEECH_END), onPartial:(t)=>this.session.partialTranscript(t), onFinal:(t)=>this.handleFinal(t), onError:(e)=>this.emit(EVENTS.ERROR,e) }; }
  async handleFinal(text) { this.session.finalTranscript(text); const classified=classifyVoiceIntent(text,this.session.mode); const request={input:text,source:'voice',interactionMode:this.session.mode,intent:classified.intent,intentConfidence:classified.confidence,sessionId:this.session.sessionId,history:this.session.history}; this.emit(EVENTS.COMMAND,request); if(this.onRequest) return this.onRequest(request); }
  async speak(text) { if(!this.tts?.speak)return; this.emit(EVENTS.TTS_START,{text}); await this.tts.speak(text); this.emit(EVENTS.TTS_END); }
  async interrupt() { if(this.tts?.stop) await this.tts.stop(); this.session.interrupt(); }
}
module.exports=VoiceService;
