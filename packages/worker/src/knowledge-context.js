class KnowledgeContext {
 constructor(){this.documents=[];}
 addDocument({id,title,type,text,metadata={}}){const doc={id:id||`doc-${Date.now()}-${this.documents.length}`,title,type,text:String(text||''),metadata};this.documents.push(doc);return doc;}
 search(query,{limit=6}={}){const terms=String(query||'').toLowerCase().split(/\W+/).filter(Boolean);return this.documents.map(d=>{const hay=`${d.title} ${d.type} ${d.text}`.toLowerCase();const score=terms.reduce((n,t)=>n+(hay.includes(t)?1:0),0);return {doc:d,score};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,limit);}
 buildContext(query,opts){return this.search(query,opts).map(x=>({id:x.doc.id,title:x.doc.title,type:x.doc.type,score:x.score,text:x.doc.text.slice(0,8000),metadata:x.doc.metadata}));}
}
module.exports=KnowledgeContext;
