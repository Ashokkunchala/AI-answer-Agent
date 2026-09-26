const {buildEvaluationPrompt}=require('./answer-evaluator');
class InterviewCoach{
 constructor({aiClient=null}={}){this.ai=aiClient;}
 async evaluate(answer,type){const prompt=buildEvaluationPrompt(answer,type);if(!this.ai?.streamAnswer)return prompt;return this.ai.streamAnswer({transcript:JSON.stringify(prompt),taskType:'interview-coaching'});}
}
module.exports=InterviewCoach;
