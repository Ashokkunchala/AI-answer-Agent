/**
 * Cloudflare platform helpers for AI-Answer-Agent.
 *
 * All bindings are optional so the Worker keeps working before infrastructure
 * is provisioned. The hot interview path only uses KV when explicitly bound
 * and never blocks on telemetry writes.
 */

const CACHE_TTL_SECONDS = 60;
const MAX_CACHEABLE_CHARS = 200_000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function makeAIRequestCacheKey(body, taskType) {
  const normalized = {
    taskType,
    model: body.model || 'auto',
    temperature: body.temperature ?? 0.7,
    max_tokens: body.max_tokens || 0,
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
  return `ai:v1:${await sha256Hex(stableStringify(normalized))}`;
}

export async function getCachedAIResponse(env, body, taskType) {
  if (!env.AI_CACHE || body.stream || body.sessionId || body.turnId) return null;
  const key = await makeAIRequestCacheKey(body, taskType);
  try {
    return await env.AI_CACHE.get(key, 'json');
  } catch (error) {
    console.warn('[Cloudflare KV] cache read failed:', error?.message || error);
    return null;
  }
}

export async function putCachedAIResponse(env, body, taskType, response) {
  if (!env.AI_CACHE || body.stream || body.sessionId || body.turnId) return;
  if (!response || response.type === 'stream') return;
  const content = String(response.content || '');
  if (content.length > MAX_CACHEABLE_CHARS) return;

  const key = await makeAIRequestCacheKey(body, taskType);
  try {
    await env.AI_CACHE.put(key, JSON.stringify({
      cached_at: new Date().toISOString(),
      response,
    }), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (error) {
    console.warn('[Cloudflare KV] cache write failed:', error?.message || error);
  }
}

export function cloudflareCapabilities(env) {
  return {
    worker: true,
    workers_ai: Boolean(env.AI),
    api_keys_kv: Boolean(env.API_KEYS),
    ai_cache_kv: Boolean(env.AI_CACHE),
    d1: Boolean(env.INTERVIEW_DB),
    r2: Boolean(env.AI_ASSETS),
    durable_objects: Boolean(env.INTERVIEW_SESSIONS),
    queue: Boolean(env.INTERVIEW_QUEUE),
    workflow: Boolean(env.INTERVIEW_WORKFLOW),
    ai_gateway: Boolean(env.GATEWAY_API_TOKEN || env.GATEWAY_API_KEY),
  };
}

export async function saveInterviewTurn(env, turn) {
  if (!env.INTERVIEW_DB) return { persisted: false, reason: 'D1 binding not configured' };

  const sessionId = String(turn.sessionId || '');
  const turnId = String(turn.turnId || crypto.randomUUID());
  if (!sessionId) return { persisted: false, reason: 'sessionId missing' };

  try {
    await env.INTERVIEW_DB.prepare(`
      INSERT INTO interview_turns
        (id, session_id, question, answer, task_type, model, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      turnId,
      sessionId,
      String(turn.question || ''),
      String(turn.answer || ''),
      String(turn.taskType || 'interview'),
      String(turn.model || 'auto'),
      Number(turn.latencyMs || 0),
    ).run();

    return { persisted: true, turnId };
  } catch (error) {
    console.warn('[Cloudflare D1] interview turn write failed:', error?.message || error);
    return { persisted: false, reason: error?.message || 'D1 write failed' };
  }
}

export async function getInterviewContext(env, sessionId, limit = 12) {
  if (!env.INTERVIEW_DB || !sessionId) return [];
  try {
    const result = await env.INTERVIEW_DB.prepare(`
      SELECT question, answer, task_type, model, created_at
      FROM interview_turns
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).bind(String(sessionId), Math.min(Math.max(Number(limit) || 12, 1), 50)).all();
    return (result.results || []).reverse();
  } catch (error) {
    console.warn('[Cloudflare D1] interview context read failed:', error?.message || error);
    return [];
  }
}

export async function saveAssetMetadata(env, asset) {
  if (!env.INTERVIEW_DB) return { persisted: false, reason: 'D1 binding not configured' };
  try {
    await env.INTERVIEW_DB.prepare(`
      INSERT INTO assets
        (id, kind, object_key, content_type, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).bind(
      String(asset.id || crypto.randomUUID()),
      String(asset.kind || 'document'),
      String(asset.objectKey),
      String(asset.contentType || 'application/octet-stream'),
      Number(asset.sizeBytes || 0),
    ).run();
    return { persisted: true };
  } catch (error) {
    console.warn('[Cloudflare D1] asset metadata write failed:', error?.message || error);
    return { persisted: false, reason: error?.message || 'D1 write failed' };
  }
}

export async function storeAsset(env, key, body, contentType = 'application/octet-stream') {
  if (!env.AI_ASSETS) return { stored: false, reason: 'R2 binding not configured' };
  try {
    await env.AI_ASSETS.put(key, body, { httpMetadata: { contentType } });
    return { stored: true, key };
  } catch (error) {
    console.warn('[Cloudflare R2] asset write failed:', error?.message || error);
    return { stored: false, reason: error?.message || 'R2 write failed' };
  }
}

export async function getAsset(env, key) {
  if (!env.AI_ASSETS) return null;
  try {
    return await env.AI_ASSETS.get(key);
  } catch (error) {
    console.warn('[Cloudflare R2] asset read failed:', error?.message || error);
    return null;
  }
}
