const TYPES=Object.freeze({TECHNICAL:'technical',CODING:'coding',SYSTEM_DESIGN:'system_design',BEHAVIORAL:'behavioral',RESUME:'resume',PROJECT:'project',FOLLOWUP:'followup',GENERAL:'general'});
function classifyQuestion(text, previous=''){
 const s=String(text||'').toLowerCase();
 if(previous && /^(why|how|what about|and what if|can you explain|then)/.test(s)) return TYPES.FOLLOWUP;
 if(/system design|design (a|an)|architecture|scale to|millions|high availability|distributed/.test(s)) return TYPES.SYSTEM_DESIGN;
 if(/write code|implement|algorithm|leetcode|complexity|time complexity|space complexity|debug this/.test(s)) return TYPES.CODING;
 if(/tell me about yourself|strength|weakness|conflict|challenge|leadership|failure|team|situation|behavioral/.test(s)) return TYPES.BEHAVIORAL;
 if(/your resume|your experience|your background|previous role/.test(s)) return TYPES.RESUME;
 if(/your project|what did you build|how did you implement|why did you choose/.test(s)) return TYPES.PROJECT;
 if(/aws|kubernetes|docker|terraform|jenkins|gitlab|python|linux|network|database|sql|cloud/.test(s)) return TYPES.TECHNICAL;
 return TYPES.GENERAL;
}
function buildAnswerPlan(type){
 const plans={
  [TYPES.TECHNICAL]:['definition','core mechanism','example','tradeoffs','interview takeaway'],
  [TYPES.CODING]:['clarify','approach','complexity','implementation','edge cases','test'],
  [TYPES.SYSTEM_DESIGN]:['requirements','scale','architecture','data','reliability','security','tradeoffs'],
  [TYPES.BEHAVIORAL]:['situation','task','action','result','lesson'],
  [TYPES.PROJECT]:['problem','architecture','decisions','implementation','failure handling','impact'],
  [TYPES.FOLLOWUP]:['connect to previous answer','direct answer','deeper detail','tradeoff'],
  [TYPES.RESUME]:['claim','evidence','specific experience','impact'],
  [TYPES.GENERAL]:['direct answer','example','key takeaway']
 };
 return plans[type]||plans[TYPES.GENERAL];
}
module.exports={TYPES,classifyQuestion,buildAnswerPlan};
