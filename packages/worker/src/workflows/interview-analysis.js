/**
 * Cloudflare Workflow for post-interview analysis.
 *
 * Enable this binding only after the class is exported from the Worker
 * entrypoint. Steps are intentionally idempotent and safe to retry.
 */
export class InterviewAnalysisWorkflow {
  constructor(env, ctx) {
    this.env = env;
    this.ctx = ctx;
  }

  async run(event, step) {
    const sessionId = String(event?.sessionId || '');
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
