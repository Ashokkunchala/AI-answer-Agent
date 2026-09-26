import { WorkflowEntrypoint } from 'cloudflare:workers';
import { routeRequest } from '../router.js';

/** Post-interview analysis workflow. Runs outside the live voice latency path. */
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

    if (!turns.length) return { status: 'completed', sessionId, report: null, reason: 'no turns' };

    const compactTranscript = turns.map((turn, index) =>
      `Q${index + 1}: ${turn.question}\nA${index + 1}: ${turn.answer}`
    ).join('\n\n').slice(0, 120000);

    const evaluation = await step.do('evaluate-interview', async () => {
      const result = await routeRequest({
        task_type: 'interview',
        stream: false,
        max_tokens: 1800,
        temperature: 0.2,
        messages: [{
          role: 'user',
          content: `Evaluate this completed technical interview. Return STRICT JSON with keys: overall_score (0-100), technical_score (0-100), communication_score (0-100), correctness_score (0-100), confidence_score (0-100), strengths (array of strings), weaknesses (array of strings), missed_points (array of strings), coaching (array of strings), question_feedback (array of objects with question, score, feedback). Do not invent facts.\n\n${compactTranscript}`,
        }],
      }, this.env);
      return result.response?.content || '{}';
    });

    let report;
    try {
      report = JSON.parse(evaluation);
    } catch {
      report = {
        overall_score: null,
        strengths: [],
        weaknesses: [],
        missed_points: [],
        coaching: ['The AI evaluation did not return valid JSON. Review the raw evaluation before using it.'],
        raw: evaluation,
      };
    }

    const summary = await step.do('persist-report', async () => {
      if (!this.env.INTERVIEW_DB) return { persisted: false };
      await this.env.INTERVIEW_DB.prepare(`
        INSERT INTO interview_reports(session_id, report_json, created_at, updated_at)
        VALUES(?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(session_id) DO UPDATE SET
          report_json = excluded.report_json,
          updated_at = datetime('now')
      `).bind(sessionId, JSON.stringify(report)).run();
      await this.env.INTERVIEW_DB.prepare(`
        UPDATE interview_sessions SET status = 'completed', updated_at = datetime('now') WHERE id = ?
      `).bind(sessionId).run();
      return { persisted: true };
    });

    return {
      status: 'completed',
      sessionId,
      report,
      summary: {
        ...summary,
        turnCount: turns.length,
        totalLatencyMs: turns.reduce((sum, turn) => sum + Number(turn.latency_ms || 0), 0),
      },
    };
  }
}
