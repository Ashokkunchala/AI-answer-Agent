const {TYPES,classifyQuestion,buildAnswerPlan}=require('./question-engine');
class InterviewEngine {
 constructor({context}={}){this.context=context;this.lastQuestion='';}
 analyze(text){const type=classifyQuestion(text,this.lastQuestion);const plan=buildAnswerPlan(type);this.lastQuestion=text;return {type,plan,context:this.context?.snapshot?.()||null};}
 promptHints(analysis){return {answerStyle:'spoken, concise, technically accurate',type:analysis.type,plan:analysis.plan,grounding:'Prefer supplied resume, JD, project and conversation context. Never invent candidate experience.'};}
}
module.exports=InterviewEngine;
