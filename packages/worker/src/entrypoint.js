import app from './index.js';
import { InterviewSession } from './durable/interview-session.js';
import { InterviewAnalysisWorkflow } from './workflows/interview-analysis.js';
import { handleInterviewQueue } from './queues/interview.js';
import { handleInterviewAPI } from './interview-api.js';
import { handleInterviewVoiceSocket } from './voice/interview-socket.js';
import { rateLimitDecision, rateLimitHeaders, securityHeaders, safeErrorMessage } from './security.js';

const PUBLIC = new Set(['/', '/health', '/v1/models', '/v1/tasks']);
const API_LIMIT = 120;
const VOICE_LIMIT = 30;

function withSecurity(response, decision) {
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders(rateLimitHeaders(decision))).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function upgradeWebSocket(request, env, ctx) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  ctx.waitUntil(handleInterviewVoiceSocket(server, env, ctx));

  const decision = rateLimitDecision(request, VOICE_LIMIT);
  const headers = securityHeaders(rateLimitHeaders(decision));
  return new Response(null, { status: 101, webSocket: client, headers });
}

const worker = {
  ...app,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isVoiceUpgrade = url.pathname === '/voice-socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (isVoiceUpgrade) {
      const decision = rateLimitDecision(request, VOICE_LIMIT);
      if (!decision.allowed) {
        return new Response(JSON.stringify({ error: 'rate_limit_exceeded', message: 'Too many voice connections. Retry later.' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', ...securityHeaders(rateLimitHeaders(decision)), 'Retry-After': String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))) },
        });
      }
      return upgradeWebSocket(request, env, ctx);
    }

    const limit = PUBLIC.has(url.pathname) ? API_LIMIT : API_LIMIT;
    const decision = rateLimitDecision(request, limit);
    if (!decision.allowed) {
      return new Response(JSON.stringify({ error: 'rate_limit_exceeded', message: 'Too many requests. Retry after the reset time.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...securityHeaders(rateLimitHeaders(decision)), 'Retry-After': String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))) },
      });
    }

    try {
      const response = await handleInterviewAPI(request, env, ctx, (nextRequest) => app.fetch(nextRequest, env, ctx));
      return withSecurity(response, decision);
    } catch (error) {
      return new Response(JSON.stringify({ error: safeErrorMessage(error) }), {
        status: error?.status || 500,
        headers: { 'Content-Type': 'application/json', ...securityHeaders(rateLimitHeaders(decision)) },
      });
    }
  },
  async queue(batch, env, ctx) {
    await handleInterviewQueue(batch, env, ctx);
  },
};

export default worker;
export { InterviewSession, InterviewAnalysisWorkflow };
