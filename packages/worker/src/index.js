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
import { concatenateChunks, base64ToBytes, jsonResponse } from '../../../shared/utils.js';

const PUBLIC_PATHS = ['/', '/health', '/v1/models', '/v1/tasks'];
const VALID_TIERS = ['standard', 'premium'];

function normalizePath(pathname) {
  if (pathname.length > 1) return pathname.replace(/\/+$/, '') || '/';
  return pathname;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Read a transcription request body that may be JSON (base64 audio) or
// multipart/form-data (real audio file upload).
async function readTranscriptionInput(request) {
  const contentType = request.headers.get('Content-Type') || '';
  try {
    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      let audio = form.get('file') || form.get('audio');
      // Workerd returns File objects for file fields.
      const bytes = await audio?.arrayBuffer?.();
      const mime = typeof audio?.type === 'string' && audio.type ? audio.type : 'audio/webm';
      return {
        bytes,
        mime,
        model: form.get('model') || undefined,
        language: form.get('language') || undefined,
        prompt: form.get('prompt') || undefined,
        temperature: form.get('temperature') !== null ? parseFloat(form.get('temperature')) : undefined,
      };
    }
    const body = await request.json();
    const { bytes, mime } = extractAudioFromJSON(body, null);
    return {
      bytes,
      mime,
      model: body.model || undefined,
      language: body.language || body.lang || undefined,
      prompt: body.prompt || undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    };
  } catch (e) {
    if (e?.status) throw e;
    throw new Error(`Invalid transcription payload: ${e.message}`);
  }
}

// Auth middleware â€” returns null if allowed, or a Response if denied.
// Direct-use mode: requests WITHOUT an API key run as the shared anonymous identity.
// Rate limiting is disabled (unlimited requests).
async function authenticate(request, env, path) {
  if (PUBLIC_PATHS.includes(path)) return null;

  const apiKey = extractApiKey(request);

  if (!apiKey) {
    request._keyData = { id: 'anon', name: 'anonymous', tier: 'anonymous' };
    return null;
  }

  const keyData = await validateApiKey(apiKey, env);
  if (!keyData) {
    return jsonResponse({ error: 'Invalid or revoked API key' }, 403, request);
  }

  // Attach key data for downstream handlers
  request._keyData = keyData;
  return null;
}

// WebSocket handler for voice transcription
async function handleVoiceSocket(webSocket, env) {
  // In-memory audio buffer per session (keyed by webSocket)
  const sessions = new Map();

  webSocket.addEventListener('message', async (event) => {
    try {
      const data = JSON.parse(event.data);

      // Control messages
      if (data.type === 'start') {
        const sessionId = crypto.randomUUID();
        sessions.set(webSocket, {
          chunks: [],
          startTime: Date.now(),
          model: data.model || 'auto',
          language: data.language || 'en',
        });
        webSocket.send(JSON.stringify({ session_id: sessionId, status: 'started' }));
        return;
      }

      if (data.type === 'end' && sessions.has(webSocket)) {
        const session = sessions.get(webSocket);
        if (!session) {
          webSocket.send(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        // Concatenate all chunks and transcribe
        const audioBytes = concatenateChunks(session.chunks);
        sessions.delete(webSocket);

        if (audioBytes.byteLength === 0) {
          webSocket.send(JSON.stringify({ text: '', error: 'No audio data' }));
          return;
        }

        const result = await transcribe(env, audioBytes, {
          model: session.model,
          language: session.language,
        }, 'audio/webm');

        webSocket.send(JSON.stringify({
          text: result.text,
          model: result.model,
          segments: result.segments || [],
          latency_ms: Date.now() - session.startTime,
        }));
        return;
      }

      // Audio chunk (base64 in JSON or binary)
      if (sessions.has(webSocket)) {
        const session = sessions.get(webSocket);
        let audioBytes;
        if (typeof data.audio === 'string') {
          // Base64 encoded audio
          audioBytes = base64ToBytes(data.audio);
        } else if (data.audio instanceof ArrayBuffer) {
          // Binary audio data
          audioBytes = data.audio;
        } else {
          webSocket.send(JSON.stringify({ error: 'Invalid audio format' }));
          return;
        }

        session.chunks.push(audioBytes);

        // Transcribe this chunk alone to get a partial
        const partialResult = await transcribe(env, audioBytes, {
          model: session.model,
          language: session.language,
        }, 'audio/webm');

        webSocket.send(JSON.stringify({
          type: 'partial',
          text: partialResult.text,
        }));
      }
    } catch (error) {
      console.error(`[Voice Socket] Error processing message: ${error}`);
      webSocket.send(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  webSocket.addEventListener('close', () => {
    // Clean up session
    sessions.delete(webSocket);
  });

  webSocket.addEventListener('error', (error) => {
    console.error(`[Voice Socket] WebSocket error: ${error}`);
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    try {
      // â”€â”€â”€ Dashboard UI (public) â”€â”€â”€
      if (path === '/dashboard') {
        return new Response(DASHBOARD_HTML, {
          headers: { 'Content-Type': 'text/html;charset=utf-8', ...corsHeaders(request) },
        });
      }

      // ── Auth check ──
      // Allow WebSocket upgrade to /voice-socket without authentication (same as other public paths)
      if (!(path === '/voice-socket' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket')) {
        const authDenied = await authenticate(request, env, path);
        if (authDenied) return authDenied;
      }
      // â”€â”€â”€ Health (public) â”€â”€â”€
      if (path === '/' || path === '/health') {
        const modelCount = Object.keys(MODELS).length;
        return jsonResponse({
          status: 'healthy',
          name: 'DevOps AI Agent',
          version: VERSION,
          engine: 'Cloudflare Workers AI (+ optional AI Gateway fallback)',
          models_count: modelCount,
          dashboard: url.origin + '/dashboard',
          auth: 'API key required (except /health, /v1/models, /v1/tasks, /dashboard)',
          auth_header: 'Authorization: Bearer dvops_<id>_<secret>',
          rate_limiting: 'Disabled â€” unlimited requests for keys and anonymous use',
          key_management: 'Direct-use UI: no key needed in the dashboard. API keys are for external tool integrations.',
          endpoints: {
            'POST /v1/chat/completions': 'OpenAI-compatible chat (auth required)',
            'POST /v1/audio/transcriptions': 'Speech-to-text (multipart or base64 JSON, auth required)',
            'POST /v1/audio/stream': 'STT streaming (chunked audio, auth required)',
            'POST /ask': 'Simple Q&A (auth required)',
            'GET /v1/models': `List all ${modelCount} models (public)`,
            'GET /v1/tasks': 'List task types (public)',
            'POST /v1/route': 'Preview routing (auth required)',
            'POST /v1/keys': 'Create API key (no auth â€” for external tools)',
            'GET /v1/keys': 'List keys',
            'POST /v1/keys/revoke': 'Revoke a key by id',
            'DELETE /v1/keys': 'Delete a key by id',
            'GET /v1/usage': 'Your usage stats (auth required)',
          },
        });
      }

      // â”€â”€â”€ List models (public) â”€â”€â”€
      if (path === '/v1/models' && request.method === 'GET') {
        return jsonResponse({
          object: 'list',
          data: Object.entries(MODELS).map(([key, m]) => ({
            id: key,
            model_id: m.id,
            name: m.name,
            params: m.params || null,
            context: m.context,
            max_tokens: m.max_tokens || null,
            speed: m.speed,
            caps: m.caps,
            bestFor: m.bestFor,
          })),
        });
      }

      // â”€â”€â”€ Task types (public) â”€â”€â”€
      if (path === '/v1/tasks' && request.method === 'GET') {
        return jsonResponse({
          tasks: Object.entries(ROUTING_TABLE).map(([key, r]) => ({
            id: key,
            label: r.label,
            primary_model: r.chains[0]?.model,
            models: r.chains.map((c) => ({
              model: c.model,
              model_id: MODELS[c.model]?.id,
              reason: c.reason,
            })),
          })),
        });
      }

      // â”€â”€â”€ Create API key (no auth needed â€” keys are for external tools) â”€â”€â”€
      if (path === '/v1/keys' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        const keyData = await createApiKey(env, {
          name: body.name,
          expires_at: body.expires_at || null,
          rate_limit: body.rate_limit ?? 0,
          tier: VALID_TIERS.includes(body.tier) ? body.tier : 'standard',
        });
        return jsonResponse({
          message: 'API key created. Save it now â€” it won\'t be shown again!',
          key: keyData.key,
          id: keyData.id,
          name: keyData.name,
          created_at: keyData.created_at,
          expires_at: keyData.expires_at,
          rate_limit: keyData.rate_limit,
          tier: keyData.tier,
        });
      }

      // â”€â”€â”€ List API keys â”€â”€â”€
      if (path === '/v1/keys' && request.method === 'GET') {
        const keys = await listApiKeys(env);
        return jsonResponse({ keys });
      }

      // â”€â”€â”€ Revoke API key â”€â”€â”€
      if (path === '/v1/keys/revoke' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        const result = await revokeApiKey(env, body.id);
        return jsonResponse(result, result.success ? 200 : 404, request);
      }

      // â”€â”€â”€ Delete API key â”€â”€â”€
      if (path === '/v1/keys' && request.method === 'DELETE') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        const result = await deleteApiKey(env, body.id);
        return jsonResponse(result, result.success ? 200 : 404, request);
      }

      // â”€â”€â”€ Usage stats â”€â”€â”€
      if (path === '/v1/usage' && request.method === 'GET') {
        // Ensure key data exists (should be set by authenticate middleware)
        if (!request._keyData) {
          return jsonResponse({ error: 'Authentication required' }, 401, request);
        }

        const today = new Date().toISOString().split('T')[0];
        const usageKey = `usage:${request._keyData.id}:${today}`;
        const usage = env.API_KEYS
          ? await env.API_KEYS.get(usageKey, { type: 'json' })
          : null;

        return jsonResponse({
          key_name: request._keyData.name,
          date: today,
          usage: usage || { requests: 0, tokens: 0, models: {} },
        });
      }

      // â”€â”€â”€ Route preview â”€â”€â”€
      if (path === '/v1/route' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        const messages = Array.isArray(body.messages) ? body.messages : [];
        const taskType = ROUTING_TABLE[body.task_type] ? body.task_type : classifyRequest(messages);
        const route = ROUTING_TABLE[taskType] || ROUTING_TABLE.general;

        return jsonResponse({
          task_type: taskType,
          task_label: route.label,
          chain: route.chains.map((c) => ({
            ...c,
            model_id: MODELS[c.model]?.id,
          })),
        });
      }

      // â”€â”€â”€ Audio transcription (OpenAI-compatible) â”€â”€â”€
      if (path === '/v1/audio/transcriptions' && ['POST', 'PUT'].includes(request.method)) {
        return await handleTranscription(request, env, ctx);
      }

      // â”€â”€â”€ STT Streaming (chunked audio for real-time) â”€â”€â”€
      if (path === '/v1/audio/stream' && ['POST', 'PUT'].includes(request.method)) {
        return await handleSTTStream(request, env);
      }

      // â”€â”€â”€ OpenAI-compatible chat completions â”€â”€â”€
      if (path === '/v1/chat/completions' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        let result;
        try {
          result = await routeRequest(body, env);
        } catch (e) {
          if (e.status) return jsonResponse({ error: e.message }, e.status, request);
          throw e;
        }
        const { response, metadata } = result;

        // Track usage without blocking the response
        if (ctx) {
          ctx.waitUntil(trackUsage(request._keyData.id, env, {
            tokens: response.usage?.total_tokens || 0,
            model: metadata.model_used,
          }));
        }

        // Streaming
        if (response.type === 'stream') {
          const completionId = `chatcmpl-${crypto.randomUUID()}`;
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const encoder = new TextEncoder();

          const pump = async () => {
            try {
              for await (const chunk of response.stream) {
                const text = chunk.response || chunk.text || chunk.content || '';
                if (text) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    model: metadata.model_used,
                    task_type: metadata.task_type,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  })}\n\n`));
                }
              }
              await writer.write(encoder.encode(`data: ${JSON.stringify({
                id: completionId,
                object: 'chat.completion.chunk',
                model: metadata.model_used,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              })}\n\n`));
              await writer.write(encoder.encode('data: [DONE]\n\n'));
            } catch (e) {
              await writer.write(encoder.encode(`data: ${JSON.stringify({ error: e.message })}\n\n`));
            } finally {
              await writer.close();
            }
          };

          if (ctx) ctx.waitUntil(pump());
          else pump();

          return new Response(readable, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              ...corsHeaders(request),
            },
          });
        }

        // Non-streaming
        return buildChatResponse(response, metadata, request);
      }

      // â”€â”€â”€ Simple ask â”€â”€â”€
      if (path === '/ask' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400, request);

        const question = body.question || body.q || body.prompt || '';
        if (!question) return jsonResponse({ error: 'Provide a "question" field' }, 400, request);

        let result;
        try {
          result = await routeRequest({
            messages: [{ role: 'user', content: question }],
            max_tokens: body.max_tokens || 0,
            temperature: body.temperature ?? 0.7,
            stream: false,
            task_type: body.task_type,
          }, env);
        } catch (e) {
          if (e.status) return jsonResponse({ error: e.message }, e.status, request);
          throw e;
        }

        if (ctx) {
          ctx.waitUntil(trackUsage(request._keyData.id, env, {
            tokens: result.response.usage?.total_tokens || 0,
            model: result.metadata.model_used,
          }));
        }

        const reply = {
          answer: result.response.content,
          task_type: result.metadata.task_type,
          model: result.metadata.model_used,
          model_id: result.metadata.model_id,
          latency_ms: result.metadata.latency_ms,
        };
        const attachments = attachmentsFrom(result.response);
        if (attachments) reply.attachments = attachments;

        return jsonResponse(reply, 200, request);
      }

      // â”€â”€â”€ 404 â”€â”€â”€
      return jsonResponse({
        error: 'Not found',
        dashboard: url.origin + '/dashboard',
        endpoints: {
          'GET /health': 'Health check (public)',
          'GET /dashboard': 'API Key Management UI (public)',
          'GET /v1/models': 'List models (public)',
          'GET /v1/tasks': 'List tasks (public)',
          'POST /v1/keys': 'Create key (no auth â€” for external tools)',
          'GET /v1/keys': 'List keys',
          'POST /v1/keys/revoke': 'Revoke key by id',
          'DELETE /v1/keys': 'Delete key by id',
          'GET /v1/usage': 'Usage stats',
          'POST /v1/route': 'Preview routing',
          'POST /v1/chat/completions': 'OpenAI-compatible chat',
          'POST /v1/audio/transcriptions': 'Speech-to-text (multipart or base64 JSON)',
          'POST /ask': 'Simple Q&A',
        },
      }, 404, request);

    } catch (error) {
      console.error(`[Error] ${error.message}`);
      return jsonResponse({ error: error.message }, error.status || 500, request);
    }
  },
  websocket: {
    async handle(webSocket, env) {
      await handleVoiceSocket(webSocket, env);
    }
  }
};

// Reflect the request Origin instead of wildcard * (works with credentials/localStorage flows)
function corsHeaders(request = null) {
  const origin = request ? request.headers.get('Origin') : null;
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function attachmentsFrom(response) {
  if (response.type === 'image') {
    return [{ type: 'image', mime_type: response.mime_type || 'image/png', data: response.data }];
  }
  if (response.type === 'tts') {
    return [{ type: 'audio', mime_type: response.mime_type || 'audio/mp3', data: response.data }];
  }
  return null;
}

function buildChatResponse(response, metadata, request) {
  const base = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    model: metadata.model_used,
    task_type: metadata.task_type,
    task_label: metadata.task_label,
    routing: {
      reason: metadata.routing_reason,
      attempts: metadata.all_attempts,
    },
    choices: [{
      index: 0,
      message: { role: 'assistant', content: response.content ?? '' },
      finish_reason: 'stop',
    }],
    usage: response.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    _metadata: { latency_ms: metadata.latency_ms, model: metadata.model_used, model_id: metadata.model_id },
  };

  const attachments = attachmentsFrom(response);
  if (attachments) base.attachments = attachments;
  if (response.type === 'embeddings') base.embedding_data = response.data;

  return jsonResponse(base, 200, request);
}

