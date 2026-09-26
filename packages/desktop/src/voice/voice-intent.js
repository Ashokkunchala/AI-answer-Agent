const MODES = Object.freeze({ INTERVIEW:'interview', GENERAL:'general', AGENT:'agent' });
const INTENTS = Object.freeze({
  INTERVIEW_QUESTION:'interview.question', INTERVIEW_FOLLOWUP:'interview.followup', BEHAVIORAL:'interview.behavioral',
  CODING:'interview.coding', SYSTEM_DESIGN:'interview.system_design', DESKTOP:'desktop.command', DEVOPS:'devops.command',
  RESEARCH:'research.command', MEMORY:'memory.command', AUTOMATION:'automation.command', CHAT:'assistant.chat'
});
const COMMAND_PATTERNS = [
  { intent: INTENTS.DESKTOP, re:/^(open|launch|close|switch to)\b/i },
  { intent: INTENTS.DEVOPS, re:/\b(docker|kubernetes|kubectl|terraform|aws|ecs|ecr|jenkins|gitlab)\b/i },
  { intent: INTENTS.RESEARCH, re:/^(research|search|find out|look up)\b/i },
  { intent: INTENTS.MEMORY, re:/\b(remember|forget|what do you remember)\b/i },
  { intent: INTENTS.AUTOMATION, re:/\b(schedule|remind|every day|every hour)\b/i },
];
function classifyVoiceIntent(text, mode=MODES.INTERVIEW) {
  const input=String(text||'').trim();
  for (const p of COMMAND_PATTERNS) if (p.re.test(input) && mode===MODES.AGENT) return {intent:p.intent, confidence:0.9};
  if (mode===MODES.INTERVIEW) {
    if (/\b(system design|design a|architecture)\b/i.test(input)) return {intent:INTENTS.SYSTEM_DESIGN,confidence:0.9};
    if (/\b(code|coding|implement|algorithm|leetcode)\b/i.test(input)) return {intent:INTENTS.CODING,confidence:0.9};
    if (/\b(tell me about yourself|strength|weakness|conflict|challenge|leadership|behavioral)\b/i.test(input)) return {intent:INTENTS.BEHAVIORAL,confidence:0.86};
    return {intent:INTENTS.INTERVIEW_QUESTION,confidence:0.7};
  }
  return {intent:INTENTS.CHAT,confidence:0.5};
}
module.exports={MODES,INTENTS,classifyVoiceIntent};
