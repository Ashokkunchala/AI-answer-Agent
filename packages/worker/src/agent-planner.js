class AgentPlanner {
 constructor({tools={}}={}){this.tools=tools;}
 plan(request){const text=String(request?.input||'');if(request?.interactionMode==='interview')return {mode:'interview',steps:[{type:'classify_question'},{type:'retrieve_context'},{type:'build_answer'},{type:'verify_answer'}]};if(request?.intent?.startsWith('devops.'))return {mode:'agent',steps:[{type:'validate_tool'},{type:'collect_state'},{type:'diagnose'},{type:'report'}]};return {mode:'general',steps:[{type:'answer'}],input:text};}
}
module.exports=AgentPlanner;
