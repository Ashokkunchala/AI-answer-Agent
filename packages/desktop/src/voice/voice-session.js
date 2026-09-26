const { EventEmitter } = require('events');
const { STATES, canTransition } = require('./voice-state');
const EVENTS = require('./voice-events');

class VoiceSession extends EventEmitter {
  constructor({ mode='interview', sessionId=`voice-${Date.now()}` }={}) { super(); this.mode=mode; this.sessionId=sessionId; this.state=STATES.IDLE; this.partial=''; this.history=[]; }
  transition(next, data={}) { if (!canTransition(this.state,next)) throw new Error(`Invalid voice transition: ${this.state} -> ${next}`); this.state=next; this.emit('state',{state:next,...data}); }
  partialTranscript(text) { this.partial=text||''; this.emit(EVENTS.PARTIAL,{text:this.partial,sessionId:this.sessionId}); }
  finalTranscript(text) { const value=String(text||'').trim(); if(!value)return; this.history.push({role:'user',text:value,ts:Date.now()}); this.partial=''; this.emit(EVENTS.FINAL,{text:value,sessionId:this.sessionId,mode:this.mode}); }
  interrupt(reason='user') { this.emit(EVENTS.INTERRUPTED,{reason,sessionId:this.sessionId}); }
  reset() { this.partial=''; this.history=[]; this.state=STATES.IDLE; }
}
module.exports=VoiceSession;
