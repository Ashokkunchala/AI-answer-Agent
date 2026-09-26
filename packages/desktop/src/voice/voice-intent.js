const INTENTS = Object.freeze({
  QUESTION: 'assistant.question',
  DESKTOP: 'desktop.command',
  FILESYSTEM: 'filesystem.command',
  BROWSER: 'browser.command',
  DEVOPS: 'devops.command',
  CODING: 'coding.command',
  RESEARCH: 'research.command',
  MEMORY: 'memory.command',
  AUTOMATION: 'automation.command'
});

const RULES = [
  { intent: INTENTS.DESKTOP, patterns: [/\b(open|launch|close|start|stop|minimize|maximize)\b/i] },
  { intent: INTENTS.FILESYSTEM, patterns: [/\b(file|folder|directory|download|document|rename|copy|move|delete)\b/i] },
  { intent: INTENTS.DEVOPS, patterns: [/\b(docker|kubernetes|kubectl|terraform|aws|ecs|ecr|jenkins|gitlab)\b/i] },
  { intent: INTENTS.CODING, patterns: [/\b(code|coding|program|debug|bug|function|script|repository)\b/i] },
  { intent: INTENTS.RESEARCH, patterns: [/\b(research|search|investigate|find out|compare)\b/i] },
  { intent: INTENTS.MEMORY, patterns: [/\b(remember|forget|what did i tell you|my preference)\b/i] },
  { intent: INTENTS.AUTOMATION, patterns: [/\b(remind|schedule|every day|every morning|when .* then)\b/i] },
  { intent: INTENTS.BROWSER, patterns: [/\b(browser|chrome|edge|website|web page|tab)\b/i] }
];

function classifyVoiceText(text) {
  const normalized = String(text || '').trim();
  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(normalized))) {
      return { intent: rule.intent, confidence: 0.78, text: normalized };
    }
  }
  return { intent: INTENTS.QUESTION, confidence: 0.9, text: normalized };
}

module.exports = { INTENTS, classifyVoiceText };
