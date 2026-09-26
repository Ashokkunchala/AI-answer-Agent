const EventEmitter=require('events');
class VoiceAIBridge extends EventEmitter{
 constructor({voiceService,aiClient,interviewEngine=null,context=null}={}){super();this.voice=voiceService;this.ai=aiClient;this.interview=interviewEngine;this.context=context;this.bound=false;}
 attach(){if(this.bound||!this.voice)return;this.bound=true;this.voice.on('voice.final',e=>this.handle(e));this.voice.on('voice.interrupted',e=>this.ai?.cancel?.(e));return this;}
 async handle({text,mode='interview',sessionId=null}){const analysis=this.interview?.analyze?.(text)||null;const context=this.context?.snapshot?.()||{};const request={input:text,source:'voice',interactionMode:mode,sessionId,questionType:analysis?.type||null,answerPlan:analysis?.plan||null,context};this.emit('request',request);if(!this.ai?.streamAnswer)return request;const answer=await this.ai.streamAnswer({transcript:text,taskType:mode==='interview'?'interview':'general',conversationContext:JSON.stringify(context),sessionId});this.emit('answer',{text:answer,request});return answer;}
}
module.exports=VoiceAIBridge;
