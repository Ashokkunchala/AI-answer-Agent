class InterviewContext {
 constructor(){this.resume=null;this.jobDescription=null;this.projects=[];this.skills=[];this.history=[];this.topics=[];this.claims=[];this.stage='unknown';}
 addTurn(role,text,meta={}){this.history.push({role,text:String(text||''),meta,ts:Date.now()});if(this.history.length>100)this.history.shift();}
 setCandidate({resume,jobDescription,projects,skills}={}){if(resume!==undefined)this.resume=resume;if(jobDescription!==undefined)this.jobDescription=jobDescription;if(projects!==undefined)this.projects=projects||[];if(skills!==undefined)this.skills=skills||[];}
 addProject(project){if(project)this.projects.push(project);}
 snapshot(){return {resume:this.resume,jobDescription:this.jobDescription,projects:this.projects,skills:this.skills,history:this.history.slice(-12),topics:this.topics,claims:this.claims,stage:this.stage};}
}
module.exports=InterviewContext;
