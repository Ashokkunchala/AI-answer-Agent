// Agent-side swarm coordinator
// Integrates with the agent CLI/core to use swarm for complex tasks

import { SwarmOrchestrator } from '../../../worker/src/swarm/orchestrator.js';

export class AgentSwarm {
  constructor(agentCore, env = null) {
    this.agent = agentCore;
    this.env = env || agentCore.env || {};
    this.orchestrator = new SwarmOrchestrator(this.env, {
      maxParallel: 3,
      enableValidation: true,
      enableBestOfN: true
    });
  }

  async shouldUseSwarm(message, context = {}) {
    // Use swarm for complex tasks
    const complexPatterns = [
      /implement.*from scratch/i,
      /build.*complete/i,
      /refactor.*entire/i,
      /fix.*multiple/i,
      /debug.*complex/i,
      /review.*entire/i,
      /create.*full.*system/i
    ];
    
    if (complexPatterns.some(p => p.test(message))) return true;
    if (context.files && context.files.length > 3) return true;
    if (message.length > 500) return true;
    
    return false;
  }

  async execute(message, options = {}) {
    const taskType = this.classifyTask(message);
    
    const result = await this.orchestrator.runTask(message, {
      type: taskType,
      tools: options.tools,
      context: options.context,
      workers: options.workers || 3
    });
    
    if (!result.success) {
      throw new Error('Swarm failed: ' + result.task.issues.join(', '));
    }
    
    return {
      content: result.result.content,
      model: result.result.model,
      cost: result.result.cost,
      validation: result.result.validation,
      metadata: {
        swarm: true,
        workersUsed: result.task.workers.length,
        allModels: result.task.results.map(r => r.model).filter(Boolean)
      }
    };
  }

  classifyTask(message) {
    if (/implement|code|function|class/i.test(message)) return 'code';
    if (/debug|fix|error|bug/i.test(message)) return 'debug';
    if (/review|check|audit/i.test(message)) return 'review';
    if (/research|explain|understand/i.test(message)) return 'research';
    return 'general';
  }

  getStats() {
    return this.orchestrator.getStats();
  }
}
