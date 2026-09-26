// DevOps AI Agent - Cloudflare Worker with API Key Auth

import { routeRequest } from './router.js';
import { classifyRequest } from './classifier.js';
import { ROUTING_TABLE, MODELS, VERSION } from './config.js';
import {
  extractApiKey, validateApiKey, trackUsage,
  createApiKey, listApiKeys, revokeApiKey, deleteApiKey,
} from './auth.js';
import { DASHBOARD_HTML } from './dashboard.js';
import { transcribe, extractAudioFromJSON } from './providers/transcription.js';
import { handleSTTStream } from './providers/stt-stream.js';
import { concatenateChunks, base64ToBytes, jsonResponse } from '../../../shared/utils.js';
import { getInterviewContext, saveInterviewTurn, cloudflareCapabilities } from './platform/cloudflare.js';

const PUBLIC_PATHS = ['/', '/health', '/v1/models', '/v1/tasks'];
const VALID_TIERS = ['standard', 'premium'];

function normalizePath(pathname) { return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname; }
async function readBody(request) { try { return await request.json(); } catch { return null; } }

async function readTranscriptionInput(request) {
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const audio = form.get('file') || form.get('audio');
      return {
        bytes: await audio?.arrayBuffer?.(),
        mime: typeof audio?.type === 'string' && audio.type ? audio.type : 'audio/webm',
        model: form.get('model') || undefined, language: form.get('language') || undefined,
        prompt: form.get('prompt') || undefined,
        temperature: form.get('temperature') !== null ? parseFloat(form.get('temperature')) : undefined,
      };
    }
    const body = await request.json();
    const { bytes, mime } = extractAudioFromJSON(body, null);
    return { bytes, mime, model: body.model || undefined, language: body.language || body.lang || undefined, prompt: body.prompt || undefined, temperature: typeof body.temperature === 'number' ? body.temperature : undefined };
  } catch (e) { if (e?.status) throw e; throw new Error(`Invalid transcription payload: ${e.message}`); }
}

async function handleTranscription(request, env) {
  const { bytes, mime, model, language, prompt, temperature } = await readTranscriptionInput(request);
  if (!bytes || bytes.byteLength === 0) return jsonResponse({ error: 'No audio data provided.' }, 400, request);
  if (bytes.byteLength > 25 * 1024 * 1024) return jsonResponse({ error: 'Audio too large (max 25MB)' }, 413, request);
  const result = await transcribe(env, bytes, { model: model || 'auto', language: language || 'en', prompt: prompt || undefined, temperature: temperature ?? 0 }, mime || 'audio/webm');
  return jsonResponse({ text: result.text, model: result.model, segments: result.segments || [], attempts: result.attempts || [] }, 200, request);
}

async function authenticate(request, env, path) {
  if (PUBLIC_PATHS.includes(path)) return null;
  const apiKey = extractApiKey(request);
  if (!apiKey) { request._keyData = { id: 'anon', name: 'anonymous', tier: 'anonymous' }; return null; }
  const keyData = await validateApiKey(apiKey, env);
  if (!keyData) return jsonResponse({ error: 'Invalid or revoked API key' }, 403, request);
  request._keyData = keyData;
  return null;
}

async function handleVoiceSocket(webSocket, env) {
  const sessions = new Map();
  const MAX_SESSION_BYTES = 25 * 1024 * 1024;
  webSocket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'start') {
        const sessionId = crypto.randomUUID();
        sessions.set(webSocket, { chunks: [], startTime: Date.now(), lastAt: Date.now(), model: data.model || 'auto', language: data.language || 'en', sessionId });
        webSocket.send(JSON.stringify({ session_id: sessionId, status: 'started' }));
        return;
      }
      if (data.type === 'end' && sessions.has(webSocket)) {
        const session = sessions.get(webSocket);
        const audioBytes = concatenateChunks(session.chunks);
        sessions.delete(webSocket);
        if (audioBytes.byteLength === 0) { webSocket.send(JSON.stringify({ text: '', error: 'No audio data' })); return; }
        const result = await transcribe(env, audioBytes, { model: session.model, language: session.language }, 'audio/webm');
        webSocket.send(JSON.stringify({ text: result.text, model: result.model, segments: result.segments || [], session_id: session.sessionId, latency_ms: Date.now() - session.startTime }));
        return;
      }
      if (sessions.has(webSocket)) {
        const session = sessions.get(webSocket);
        let audioBytes;
        if (typeof data.audio === 'string') audioBytes = base64ToBytes(data.audio);
        else if (data.audio instanceof ArrayBuffer) audioBytes = data.audio;
        else { webSocket.send(JSON.stringify({ error: 'Invalid audio format' })); return; }
        session.chunks.push(audioBytes); session.lastAt = Date.now();
        if (session.chunks.reduce((a, c) => a + c.byteLength, 0) > MAX_SESSION_BYTES) { sessions.delete(webSocket); webSocket.send(JSON.stringify({ error: 'Session exceeded max audio size, call end' })); return; }
        const partialResult = await transcribe(env, audioBytes, { model: session.model, language: session.language }, 'audio/webm');
        webSocket.send(JSON.stringify({ type: 'partial', text: partialResult.text, session_id: session.sessionId }));
      }
    } catch (error) { console.error(`[Voice Socket] Error processing message: ${error}`); try { webSocket.send(JSON.stringify({ error: 'Internal server error' })); } catch {} }
  });
  webSocket.addEventListener('close', () => sessions.delete(webSocket));
  webSocket.addEventListener('error', (error) => console.error('[Voice Socket] WebSocket error:', error));
}

function sessionIdFromPath(path) {
  const match = path.match(/^\/api\/session\/([^/]+)(?:\/(context|finalize|report))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] || null } : null;
}

async function handleSessionRoute(request, env, path) {
  const parsed = sessionIdFromPath(path);
  if (path === '/api/session' && request.method === 'POST') {
    const body = await readBody(request) || {};
    const sessionId = String(body.sessionId || crypto.randomUUID());
    if (env.INTERVIEW_DB) await env.INTERVIEW_DB.prepare(`INSERT OR IGNORE INTO interview_sessions (id,candidate_name,role_title,company,status,created_at,updated_at) VALUES (?,?,?,?, 'active',datetime('now'),datetime('now'))`).bind(sessionId, body.candidateName || null, body.roleTitle || null, body.company || null).run();
    return jsonResponse({ session_id: sessionId, status: 'active', persisted: Boolean(env.INTERVIEW_DB) }, 201, request);
  }
  if (!parsed) return null;
  const { id, action } = parsed;
  if (request.method === 'GET' && !action) {
    if (!env.INTERVIEW_DB) return jsonResponse({ session_id: id, turns: [], report: null, persisted: false }, 200, request);
    const session = await env.INTERVIEW_DB.prepare('SELECT * FROM interview_sessions WHERE id = ?').bind(id).first();
    if (!session) return jsonResponse({ error: 'Interview session not found' }, 404, request);
    const reportRow = await env.INTERVIEW_DB.prepare('SELECT report_json, created_at, updated_at FROM interview_reports WHERE session_id = ?').bind(id).first();
    return jsonResponse({ session, report: reportRow ? JSON.parse(reportRow.report_json) : null }, 200, request);
  }
  if (request.method === 'GET' && action === 'context') {
    const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get('limit') || 50), 1), 100);
    return jsonResponse({ session_id: id, turns: await getInterviewContext(env, id, limit) }, 200, request);
  }
  if (request.method === 'POST' && action === 'finalize') {
    if (env.INTERVIEW_DB) await env.INTERVIEW_DB.prepare("UPDATE interview_sessions SET status = 'processing', updated_at = datetime('now') WHERE id = ?").bind(id).run();
    let workflowId = null;
    if (env.INTERVIEW_WORKFLOW) workflowId = (await env.INTERVIEW_WORKFLOW.create({ params: { sessionId: id } })).id;
    return jsonResponse({ session_id: id, status: workflowId ? 'processing' : 'completed', workflow_id: workflowId }, 202, request);
  }
  if (request.method === 'GET' && action === 'report') {
    if (!env.INTERVIEW_DB) return jsonResponse({ error: 'D1 is not configured' }, 503, request);
    const row = await env.INTERVIEW_DB.prepare('SELECT report_json, created_at, updated_at FROM interview_reports WHERE session_id = ?').bind(id).first();
    return row ? jsonResponse({ session_id: id, status: 'completed', report: JSON.parse(row.report_json), created_at: row.created_at, updated_at: row.updated_at }, 200, request) : jsonResponse({ session_id: id, status: 'pending', report: null }, 200, request);
  }
  return jsonResponse({ error: 'Unsupported session operation' }, 405, request);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url); const path = normalizePath(url.pathname);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(request) });
    try {
      if (path === '/dashboard') return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html;charset=utf-8', ...corsHeaders(request) } });
      if (!(path === '/voice-socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket')) { const authDenied = await authenticate(request, env, path); if (authDenied) return authDenied; }

      if (path === '/' || path === '/health') return jsonResponse({
        status: 'healthy', name: 'DevOps AI Agent', version: VERSION,
        engine: 'Cloudflare Workers AI (+ optional AI Gateway fallback)', models_count: Object.keys(MODELS).length,
        dashboard: url.origin + '/dashboard', capabilities: cloudflareCapabilities(env),
        endpoints: { 'POST /v1/chat/completions': 'OpenAI-compatible chat', 'POST /api/answer': 'Realtime interview answer', 'POST /api/session': 'Create interview session', 'GET /api/session/:id': 'Get session/report', 'GET /api/session/:id/context': 'Get persisted turns', 'POST /api/session/:id/finalize': 'Start post-interview analysis', 'GET /api/session/:id/report': 'Get interview evaluation report', 'POST /v1/audio/transcriptions': 'Speech-to-text', 'POST /v1/audio/stream': 'Streaming STT' },
      });

      const sessionResponse = await handleSessionRoute(request, env, path); if (sessionResponse) return sessionResponse;
      if (path === '/v1/models' && request.method === 'GET') return jsonResponse({ object: 'list', data: Object.entries(MODELS).map(([key, m]) => ({ id: key, model_id: m.id, name: m.name, params: m.params || null, context: m.context, max_tokens: m.max_tokens || null, speed: m.speed, caps: m.caps, bestFor: m.bestFor })) });
      if (path === '/v1/tasks' && request.method === 'GET') return jsonResponse({ tasks: Object.entries(ROUTING_TABLE).map(([key, r]) => ({ id: key, label: r.label, primary_model: r.chains[0]?.model, models: r.chains.map((c) => ({ model: c.model, model_id: MODELS[c.model]?.id, reason: c.reason })) })) });

      if (path === '/v1/keys' && request.method === 'POST') {
        const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);
        const keyData = await createApiKey(env, { name: body.name, expires_at: body.expires_at || null, rate_limit: body.rate_limit ?? 0, tier: VALID_TIERS.includes(body.tier) ? body.tier : 'standard' });
        return jsonResponse({ message: 'API key created. Save it now — it won\'t be shown again!', ...keyData }, 201, request);
      }
      if (path === '/v1/keys' && request.method === 'GET') { if (!request._keyData || request._keyData.id === 'anon') return jsonResponse({ error: 'Authentication required to list keys' }, 401, request); return jsonResponse({ keys: await listApiKeys(env) }); }
      if (path === '/v1/keys/revoke' && request.method === 'POST') { if (!request._keyData || request._keyData.id === 'anon') return jsonResponse({ error: 'Authentication required to revoke keys' }, 401, request); const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request); const result = await revokeApiKey(env, body.id); return jsonResponse(result, result.success ? 200 : 404, request); }
      if (path === '/v1/keys' && request.method === 'DELETE') { if (!request._keyData || request._keyData.id === 'anon') return jsonResponse({ error: 'Authentication required to delete keys' }, 401, request); const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request); const result = await deleteApiKey(env, body.id); return jsonResponse(result, result.success ? 200 : 404, request); }
      if (path === '/v1/usage' && request.method === 'GET') { if (!request._keyData) return jsonResponse({ error: 'Authentication required' }, 401, request); const today = new Date().toISOString().split('T')[0]; const usageKey = `usage:${request._keyData.id}:${today}`; const usage = env.API_KEYS ? await env.API_KEYS.get(usageKey, { type: 'json' }) : null; return jsonResponse({ key_name: request._keyData.name, date: today, usage: usage || { requests: 0, tokens: 0, models: {} } }); }
      if (path === '/v1/route' && request.method === 'POST') { const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request); const messages = Array.isArray(body.messages) ? body.messages : []; const taskType = ROUTING_TABLE[body.task_type] ? body.task_type : classifyRequest(messages); const route = ROUTING_TABLE[taskType] || ROUTING_TABLE.general; return jsonResponse({ task_type: taskType, task_label: route.label, chain: route.chains.map((c) => ({ ...c, model_id: MODELS[c.model]?.id })) }); }
      if (path === '/v1/audio/transcriptions' && ['POST', 'PUT'].includes(request.method)) return await handleTranscription(request, env, ctx);
      if (path === '/v1/audio/stream' && ['POST', 'PUT'].includes(request.method)) return await handleSTTStream(request, env);
      if (path === '/v1/chat/completions' && request.method === 'POST') { const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request); return respondToChat(body, env, ctx, request, null); }
      if (path === '/ask' && request.method === 'POST') { const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request); const question = body.question || body.q || body.prompt || ''; if (!question) return jsonResponse({ error: 'Provide a "question" field' }, 400, request); const result = await routeRequest({ messages: [{ role: 'user', content: question }], max_tokens: body.max_tokens || 0, temperature: body.temperature ?? 0.7, stream: false, task_type: body.task_type }, env); if (ctx) ctx.waitUntil(trackUsage(request._keyData.id, env, { tokens: result.response.usage?.total_tokens || 0, model: result.metadata.model_used })); const reply = { answer: result.response.content, task_type: result.metadata.task_type, model: result.metadata.model_used, model_id: result.metadata.model_id, latency_ms: result.metadata.latency_ms }; const attachments = attachmentsFrom(result.response); if (attachments) reply.attachments = attachments; return jsonResponse(reply, 200, request); }

      if (path === '/api/answer' && request.method === 'POST') {
        const body = await readBody(request); if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);
        const question = body.question || body.q || ''; if (!question) return jsonResponse({ error: 'Provide a "question" field' }, 400, request);
        const messages = []; if (body.conversationContext) messages.push({ role: 'system', content: String(body.conversationContext) }); if (Array.isArray(body.history)) messages.push(...body.history.slice(-12).filter((m) => m && m.role && m.content)); messages.push({ role: 'user', content: question });
        return respondToChat({ model: body.model || 'auto', messages, max_tokens: body.max_tokens || 512, temperature: body.temperature ?? 0.3, stream: body.stream !== false, task_type: 'interview', sessionId: body.sessionId || null, turnId: body.turnId || null, resume: body.resume, jobDesc: body.jobDesc, targetName: body.targetName, participants: body.participants, candidateName: body.candidateName, roleTitle: body.roleTitle, company: body.company }, env, ctx, request, { sessionId: body.sessionId || null, turnId: body.turnId || null, question, candidateName: body.candidateName, roleTitle: body.roleTitle, company: body.company });
      }

      return jsonResponse({ error: 'Not found', dashboard: url.origin + '/dashboard' }, 404, request);
    } catch (error) { console.error(`[Error] ${error.message}`); return jsonResponse({ error: error.message }, error.status || 500, request); }
  },
  websocket: { async handle(webSocket, env) { await handleVoiceSocket(webSocket, env); } }
};

function corsHeaders(request = null) { const origin = request ? request.headers.get('Origin') : null; return { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' }; }
function attachmentsFrom(response) { if (response.type === 'image') return [{ type: 'image', mime_type: response.mime_type || 'image/png', data: response.data }]; if (response.type === 'tts') return [{ type: 'audio', mime_type: response.mime_type || 'audio/mp3', data: response.data }]; return null; }
function buildChatResponse(response, metadata, request) { const base = { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', model: metadata.model_used, task_type: metadata.task_type, task_label: metadata.task_label, routing: { reason: metadata.routing_reason, attempts: metadata.all_attempts }, choices: [{ index: 0, message: { role: 'assistant', content: response.content ?? '' }, finish_reason: 'stop' }], usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, _metadata: { latency_ms: metadata.latency_ms, model: metadata.model_used, model_id: metadata.model_id } }; const attachments = attachmentsFrom(response); if (attachments) base.attachments = attachments; if (response.type === 'embeddings') base.embedding_data = response.data; return jsonResponse(base, 200, request); }

async function respondToChat(body, env, ctx, request, meta) {
  let result; try { result = await routeRequest(body, env); } catch (e) { const routing = e.attempts ? { attempts: e.attempts } : undefined; return jsonResponse({ error: e.message, ...(routing ? { routing } : {}) }, e.status || 500, request); }
  const { response, metadata } = result;
  if (ctx) ctx.waitUntil(Promise.resolve(trackUsage(request._keyData.id, env, { tokens: response.usage?.total_tokens || 0, model: metadata.model_used })).catch((err) => console.log('[Usage] tracking error:', err.message)));
  if (response.type === 'stream') return streamChatResponse(response, metadata, request, { ...(meta || {}), env }, ctx);
  return buildChatResponse(response, metadata, request);
}

function streamChatResponse(response, metadata, request, meta, ctx) {
  const completionId = `chatcmpl-${crypto.randomUUID()}`; const { readable, writable } = new TransformStream(); const writer = writable.getWriter(); const encoder = new TextEncoder();
  const pump = async () => {
    let fullAnswer = '';
    try {
      for await (const chunk of response.stream) {
        const text = chunk.response || chunk.text || chunk.content || '';
        if (!text) continue;
        fullAnswer += text;
        const payload = { id: completionId, object: 'chat.completion.chunk', model: metadata.model_used, task_type: metadata.task_type, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
        if (meta?.sessionId) payload.session_id = meta.sessionId; if (meta?.turnId) payload.turn_id = meta.turnId;
        await writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      if (meta?.sessionId && fullAnswer && meta.env?.INTERVIEW_DB) {
        const persistPromise = saveInterviewTurn(meta.env, { sessionId: meta.sessionId, turnId: meta.turnId, question: meta.question || '', answer: fullAnswer, taskType: metadata.task_type, model: metadata.model_used, latencyMs: metadata.latency_ms, candidateName: meta.candidateName, roleTitle: meta.roleTitle, company: meta.company });
        if (ctx) ctx.waitUntil(persistPromise); else await persistPromise;
      }
      const finish = { id: completionId, object: 'chat.completion.chunk', model: metadata.model_used, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      if (meta?.sessionId) finish.session_id = meta.sessionId; if (meta?.turnId) finish.turn_id = meta.turnId;
      await writer.write(encoder.encode(`data: ${JSON.stringify(finish)}\n\n`)); await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch (e) { await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`)); }
    finally { await writer.close(); }
  };
  if (ctx) ctx.waitUntil(pump()); else pump();
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...corsHeaders(request) } });
}
