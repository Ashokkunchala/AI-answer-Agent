class WakeWordGate{
 constructor({phrases=['hey jarvis','jarvis','hey assistant'],cooldownMs=1200}={}){this.phrases=phrases.map(x=>x.toLowerCase());this.cooldownMs=cooldownMs;this.last=0;this.active=false;}
 detect(text){const now=Date.now();if(now-this.last<this.cooldownMs)return false;const s=String(text||'').toLowerCase().trim();const hit=this.phrases.some(p=>s.startsWith(p)||s.includes(` ${p} `));if(hit){this.last=now;this.active=true;}return hit;}
 consume(text){if(!this.active)return {activated:false,text};const s=String(text||'').trim();for(const p of this.phrases){const re=new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[,: -]*`,'i');if(re.test(s))return {activated:true,text:s.replace(re,'').trim()};}return {activated:true,text:s};}
 deactivate(){this.active=false;}
}
module.exports=WakeWordGate;
