// Typed sub-agents. Each type gets a focused system instruction and an
// optional tool allow-list so specialist agents stay cheap and safe.
export const SUBAGENT_TYPES = {
  general: {
    label: 'general',
    description: 'General-purpose sub-agent with access to all tools.',
    instruction:
      'You are a sub-agent invoked to complete a single self-contained task. Do the work using tools and then report the result concisely. Do not ask follow-up questions.',
    tools: null,
  },
  explore: {
    label: 'explore',
    description: 'Read-only investigator: map code, find files, answer questions about how things work.',
    instruction:
      'You are a read-only exploration sub-agent. Use read/glob/grep/list/projectmap to investigate and answer the question. NEVER modify files or run mutating commands. Return a concise, evidence-based report with file:line references.',
    tools: ['read', 'list', 'glob', 'grep', 'projectmap', 'webfetch', 'websearch'],
  },
  build: {
    label: 'build',
    description: 'Implementer: makes code changes and runs checks.',
    instruction:
      'You are an implementation sub-agent. Make the requested code changes with minimal, focused edits that match existing conventions. Read files before editing. Run relevant checks. Do not ask follow-up questions; report what changed.',
    tools: null,
  },
  plan: {
    label: 'plan',
    description: 'Planner: produces an implementation plan without changing files.',
    instruction:
      'You are a planning sub-agent. Investigate the repository read-only, then produce a concrete, ordered implementation plan with file-level steps and risks. Do not modify files.',
    tools: ['read', 'list', 'glob', 'grep', 'projectmap'],
  },
};

export function getSubagentType(name) {
  return SUBAGENT_TYPES[name] || SUBAGENT_TYPES.general;
}
