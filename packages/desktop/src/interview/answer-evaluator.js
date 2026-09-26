const RUBRICS={behavioral:['situation','task','action','result','specificity'],technical:['correctness','depth','example','tradeoffs','clarity'],coding:['approach','complexity','correctness','edge_cases','tests'],system_design:['requirements','scale','architecture','data','reliability','security','tradeoffs']};
function buildEvaluationPrompt(answer,type='technical'){return {task:'evaluate_interview_answer',type,answer,criteria:RUBRICS[type]||RUBRICS.technical,output:{strengths:'array',gaps:'array',followUps:'array',improvedAnswer:'string'}};}
module.exports={RUBRICS,buildEvaluationPrompt};
