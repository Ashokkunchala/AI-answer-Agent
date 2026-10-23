import { getSubagentType, SUBAGENT_TYPES } from './types.js';

// Coordinates typed sub-agent runs. The actual agent loop lives in AgentCore;
// this class resolves the requested specialist and forwards the run.
export class SubagentManager {
  constructor(opts = {}) {
    this.agent = opts.agent;
  }

  list() {
    return Object.values(SUBAGENT_TYPES).map(({ label, description }) => ({ name: label, description }));
  }

  async run({ prompt, description = '', subagent_type = 'general', onEvent }) {
    if (!this.agent) throw new Error('SubagentManager requires an AgentCore instance');
    const type = getSubagentType(subagent_type);
    return this.agent.runSubagent({ description: description || type.label, prompt, subagent_type, onEvent });
  }
}

// Backwards-compatible thin wrapper (kept as a seam for direct invocation).
export class SubAgent {
  constructor(opts = {}) {
    this.manager = new SubagentManager({ agent: opts.agent });
  }

  async run(args) {
    const output = await this.manager.run(args);
    return { ok: true, subagent_type: args.subagent_type || 'general', output };
  }
}
