class SpeakerTracker{
 constructor(){this.speakers=new Map();this.lastSpeaker=null;}
 observe({speakerId,role='unknown',text=''}){if(!speakerId)return null;const s=this.speakers.get(speakerId)||{speakerId,role,turns:0};s.turns++;if(role!=='unknown')s.role=role;if(text)s.lastText=text;this.speakers.set(speakerId,s);this.lastSpeaker=speakerId;return s;}
 snapshot(){return [...this.speakers.values()];}
}
module.exports=SpeakerTracker;
