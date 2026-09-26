import { getInterviewContext, saveInterviewTurn } from './platform/cloudflare.js';
import { answerShield, interviewMode, likelyFollowUps, scoreAnswerHeuristically } from './interview/intelligence.js';

function json(data, status = 200, request) {
  const origin = request?.headers.get('Origin');
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function matchSession(path) {
  const match = path.match(/^\/api\/session\/([^/]+)(?:\/(context|finalize|report))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || null } : null;
}

async function bodyJson(request) {
  try { return await request.json(); } catch { return {}; }
}

async function createSession(request, env) {
  const body = await bodyJson(request);
  const sessionId = String(body.sessionId || crypto.randomUUID());
  if (env.INTERVIEW_DB) {
    await env.INTERVIEW_DB.prepare(`
      INSERT OR IGNORE INTO interview_sessions
        (id, candidate_name, role_title, company, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'))
    `).bind(sessionId, body.candidateName || null, body.roleTitle || null, body.company || null).run();
  }
  return json({ session_id: sessionId, status: 'active', persisted: Boolean(env.INTERVIEW_DB) }, 201, request);
}

async function getSession(id, request, env) {
  if (!env.INTERVIEW_DB) return json({ session_id: id, persisted: false, report: null }, 200, request);
  const session = await env.INTERVIEW_DB.prepare('SELECT * FROM interview_sessions WHERE id = ?').bind(id).first();
  if (!session) return json({ error: 'Interview session not found' }, 404, request);
  const report = await env.INTERVIEW_DB.prepare('SELECT report_json, created_at, updated_at FROM interview_reports WHERE session_id = ?').bind(id).first();
  return json({ session, report: report ? JSON.parse(report.report_json) : null }, 200, request);
}

async function finalizeSession(id, request, env) {
  if (env.INTERVIEW_DB) {
    await env.INTERVIEW_DB.prepare("UPDATE interview_sessions SET status = 'processing', updated_at = datetime('now') WHERE id = ?").bind(id).run();
  }
  let workflowId = null;
  if (env.INTERVIEW_WORKFLOW) {
    const instance = await env.INTERVIEW_WORKFLOW.create({ params: { sessionId: id } });
    workflowId = instance.id;
  }
  return json({ session_id: id, status: workflowId ? 'processing' : 'completed', workflow_id: workflowId }, 202, request);
}

async function getReport(id, request, env) {
  if (!env.INTERVIEW_DB) return json({ error: 'D1 is not configured' }, 503, request);
  const row = await env.INTERVIEW_DB.prepare('SELECT report_json, created_at, updated_at FROM interview_reports WHERE session_id = ?').bind(id).first();
  if (!row) return json({ session_id: id, status: 'pending', report: null }, 200, request);
  return json({ session_id: id, status: 'completed', report: JSON.parse(row.report_json), created_at: row.created_at, updated_at: row.updated_at }, 200, request);
}

function parseSSEChunk(text, state) {
  state.buffer += text;
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const raw = line.slice(6).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const event = JSON.parse(raw);
      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') state.answer += delta;
      if (event?.model) state.model = event.model;
    } catch {}
  }
}

function qualityMeta(question, answer, body, taskType = 'interview') {
  const mode = interviewMode(question, taskType);
  const guard = answerShield(answer, { question, resume: body.resume, taskType });
  const quality = scoreAnswerHeuristically(question, answer, { resume: body.resume, jobDesc: body.jobDesc, taskType });
  return {
    mode,
    quality,
    guardrails: guard,
    followups: likelyFollowUps(question, mode),
  };
}

async function persistStreamingAnswer(response, meta, env, ctx) {
  if (!response.body || !meta.sessionId) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = { buffer: '', answer: '', model: meta.model || 'auto' };

  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        const analysis = qualityMeta(meta.question, state.answer, meta.body, meta.taskType);
        const payload = {
          type: 'interview_meta',
          mode: analysis.mode,
          quality: analysis.quality,
          guardrails: analysis.guardrails,
          followups: analysis.followups,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));

        if (state.answer && env.INTERVIEW_DB) {
          const persist = saveInterviewTurn(env, {
            sessionId: meta.sessionId,
            turnId: meta.turnId,
            question: meta.question,
            answer: state.answer,
            taskType: meta.taskType || 'interview',
            model: state.model,
            latencyMs: meta.latencyMs || 0,
            candidateName: meta.body.candidateName,
            roleTitle: meta.body.roleTitle,
            company: meta.body.company,
          });
          if (ctx) ctx.waitUntil(persist);
          else await persist;
        }
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });
      parseSSEChunk(text, state);
      controller.enqueue(encoder.encode(text));
    },
    cancel(reason) { reader.cancel(reason); },
  });

  return new Response(stream, { status: response.status, headers: response.headers });
}

export async function handleInterviewAPI(request, env, ctx, next) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/session' && request.method === 'POST') return createSession(request, env);

  const session = matchSession(path);
  if (session) {
    if (request.method === 'GET' && !session.action) return getSession(session.id, request, env);
    if (request.method === 'GET' && session.action === 'context') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 100);
      return json({ session_id: session.id, turns: await getInterviewContext(env, session.id, limit) }, 200, request);
    }
    if (request.method === 'POST' && session.action === 'finalize') return finalizeSession(session.id, request, env);
    if (request.method === 'GET' && session.action === 'report') return getReport(session.id, request, env);
  }

  if (path === '/api/answer' && request.method === 'POST') {
    const body = await bodyJson(request);
    if (!body.question && !body.q) return next(request);
    const question = String(body.question || body.q);
    const sessionId = body.sessionId ? String(body.sessionId) : null;
    const enriched = {
      ...body,
      question,
      sessionId,
      turnId: body.turnId || crypto.randomUUID(),
    };
    const forwarded = new Request(request, { body: JSON.stringify(enriched) });
    const started = Date.now();
    const response = await next(forwarded);
    if (!sessionId) return response;

    const isSSE = response.headers.get('content-type')?.includes('text/event-stream');
    if (!isSSE) {
      if (!env.INTERVIEW_DB) return response;
      try {
        const data = await response.clone().json();
        const answer = data?.choices?.[0]?.message?.content || data?.answer || '';
        const analysis = qualityMeta(question, answer, body, data?.task_type || 'interview');
        const headers = new Headers(response.headers);
        headers.set('X-Interview-Mode', analysis.mode);
        headers.set('X-Interview-Quality', String(analysis.quality.overall));
        return new Response(JSON.stringify({ ...data, interview: analysis }), { status: response.status, headers });
      } catch {
        return response;
      }
    }

    return persistStreamingAnswer(response, {
      sessionId,
      turnId: enriched.turnId,
      question,
      candidateName: enriched.candidateName,
      roleTitle: enriched.roleTitle,
      company: enriched.company,
      latencyMs: Date.now() - started,
      body: enriched,
      taskType: enriched.task_type || 'interview',
    }, env, ctx);
  }

  return next(request);
}
