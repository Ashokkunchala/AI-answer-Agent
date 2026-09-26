import { WorkflowEntrypoint } from 'cloudflare:workers';

/** Post-interview analysis workflow. */
export class InterviewAnalysisWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const sessionId = String(event?.payload?.sessionId || event?.sessionId || '');
    if (!sessionId) return { status: 'skipped', reason: 'sessionId missing' };

    const turns = await step.do('load-interview', async () => {
      if (!this.env.INTERVIEW_DB) return [];
      const result = await this.env.INTERVIEW_DB.prepare(`
        SELECT question, answer, task_type, model, latency_ms, created_at
        FROM interview_turns
        WHERE session_id = ?
        ORDER BY created_at ASC
      `).bind(sessionId).all();
      return result.results || [];
    });

    const summary = await step.do('build-summary', async () => ({
      sessionId,
      turnCount: turns.length,
      taskTypes: [...new Set(turns.map((turn) => turn.task_type))],
      totalLatencyMs: turns.reduce((sum, turn) => sum + Number(turn.latency_ms || 0), 0),
    }));

    return { status: 'completed', summary };
  }
}
