const { spawn } = require('child_process');
class TTSService {
  constructor({ command=null }={}) { this.command=command || (process.platform==='win32' ? 'powershell.exe' : 'say'); this.proc=null; }
  async speak(text) { await this.stop(); const value=String(text||'').trim(); if(!value)return; if(process.platform==='win32'){ this.proc=spawn(this.command,['-NoProfile','-Command',`Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak(${JSON.stringify(value)})`],{stdio:'ignore'}); } else { this.proc=spawn(this.command,[value],{stdio:'ignore'}); } await new Promise((resolve,reject)=>{this.proc.once('exit',resolve);this.proc.once('error',reject);}); this.proc=null; }
  async stop(){ if(this.proc){this.proc.kill();this.proc=null;} }
}
module.exports=TTSService;
