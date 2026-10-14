// Thin wrapper around AgentCore's sub-agent runner. Kept as a seam so callers
// can invoke sub-agents directly without going through a tool call.
export class SubAgent {
  constructor(opts = {}) {
    this.agent = opts.agent;
  }

  async run({ prompt, description = '', subagent_type = 'general' }) {
    if (!this.agent) throw new Error('SubAgent requires an AgentCore instance');
    const output = await this.agent.runSubagent({ description: description || subagent_type, prompt });
    return { ok: true, subagent_type, output };
  }
}
