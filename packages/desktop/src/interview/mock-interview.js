class MockInterviewEngine{
 constructor({questionBank=[]}={}){this.questionBank=questionBank;this.index=0;this.history=[];}
 start({role='DevOps',level='mid'}={}){this.role=role;this.level=level;this.index=0;this.history=[];return {role,level,status:'started'};}
 nextQuestion(){const q=this.questionBank[this.index++];if(!q)return null;this.history.push({question:q});return q;}
 recordAnswer(answer){const last=this.history[this.history.length-1];if(last)last.answer=answer;return last;}
 snapshot(){return {role:this.role,level:this.level,index:this.index,history:this.history};}
}
module.exports=MockInterviewEngine;
