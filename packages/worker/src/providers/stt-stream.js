// Chunked speech-to-text endpoint. Session state is stored in R2 so requests
// can be served by different Cloudflare Worker isolates.
import { transcribe } from './transcription.js';
import { concatenateChunks, base64ToBytes, jsonResponse } from '../../../../shared/utils.js';

const SESSION_PREFIX = 'stt-sessions/';
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_BYTES = 25 * 1024 * 1024;
const sessionKey = (id) => `${SESSION_PREFIX}${id}/`;
const validSessionId = (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);

async function deleteSession(env, id, chunkCount) {
  const keys = Array.from({ length: chunkCount }, (_, i) => `${sessionKey(id)}${String(i).padStart(6, '0')}.bin`);
  keys.push(`${sessionKey(id)}manifest.json`);
  await Promise.all(keys.map((key) => env.AI_ASSETS.delete(key)));
}

async function getSession(env, id) {
  const object = await env.AI_ASSETS.get(`${sessionKey(id)}manifest.json`);
  if (!object) return null;
  const session = await object.json();
  if (Date.now() - session.lastAt > SESSION_TTL_MS) {
    await deleteSession(env, id, session.chunkCount);
    return null;
  }
  return session;
}

export async function sweepStaleSTTSessions(env) {
  if (!env.AI_ASSETS) return 0;
  let cursor;
  let removed = 0;
  do {
    const page = await env.AI_ASSETS.list({ prefix: SESSION_PREFIX, cursor, limit: 1000 });
    for (const item of page.objects) {
      if (!item.key.endsWith('/manifest.json')) continue;
      const object = await env.AI_ASSETS.get(item.key);
      if (!object) continue;
      const session = await object.json();
      if (Date.now() - session.lastAt <= SESSION_TTL_MS) continue;
      const id = item.key.slice(SESSION_PREFIX.length, -'/manifest.json'.length);
      await deleteSession(env, id, session.chunkCount || 0);
      removed++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return removed;
}

export async function handleSTTStream(request, env) {
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    const body = await request.json();

    if (body.type === 'start') {
      if (!env.AI_ASSETS) return jsonResponse({ error: 'Persistent audio session storage is not configured' }, 503);
      const sessionId = crypto.randomUUID();
      const session = {
        startTime: Date.now(), lastAt: Date.now(), totalBytes: 0, chunkCount: 0,
        model: body.model || 'auto', language: body.language || 'en',
      };
      await env.AI_ASSETS.put(`${sessionKey(sessionId)}manifest.json`, JSON.stringify(session), {
        httpMetadata: { contentType: 'application/json' },
      });
      return jsonResponse({ session_id: sessionId, status: 'started' });
    }

    if (body.type === 'end' && body.session_id) {
      if (!validSessionId(body.session_id)) return jsonResponse({ error: 'Invalid session id' }, 400);
      if (!env.AI_ASSETS) return jsonResponse({ error: 'Persistent audio session storage is not configured' }, 503);
      const session = await getSession(env, body.session_id);
      if (!session) return jsonResponse({ error: 'Session not found' }, 404);

      const chunks = [];
      for (let i = 0; i < session.chunkCount; i++) {
        const object = await env.AI_ASSETS.get(`${sessionKey(body.session_id)}${String(i).padStart(6, '0')}.bin`);
        if (!object) return jsonResponse({ error: 'Audio session is incomplete' }, 409);
        chunks.push(await object.arrayBuffer());
      }
      const audioBytes = concatenateChunks(chunks);
      await deleteSession(env, body.session_id, session.chunkCount);
      if (audioBytes.byteLength === 0) return jsonResponse({ text: '', error: 'No audio data' });

      const result = await transcribe(env, audioBytes, { model: session.model, language: session.language }, 'audio/webm');
      return jsonResponse({
        text: result.text, model: result.model, segments: result.segments || [],
        latency_ms: Date.now() - session.startTime,
      });
    }

    if (body.audio) {
      if (!validSessionId(body.session_id)) return jsonResponse({ error: 'Invalid session id' }, 400);
      if (!env.AI_ASSETS) return jsonResponse({ error: 'Persistent audio session storage is not configured' }, 503);
      const session = await getSession(env, body.session_id);
      if (!session) return jsonResponse({ error: 'Session not found' }, 404);
      const bytes = base64ToBytes(body.audio);
      if (session.totalBytes + bytes.byteLength > MAX_SESSION_BYTES) {
        await deleteSession(env, body.session_id, session.chunkCount);
        return jsonResponse({ error: 'Session exceeded max audio size' }, 413);
      }

      const chunkKey = `${sessionKey(body.session_id)}${String(session.chunkCount).padStart(6, '0')}.bin`;
      await env.AI_ASSETS.put(chunkKey, bytes);
      session.lastAt = Date.now();
      session.totalBytes += bytes.byteLength;
      session.chunkCount++;
      await env.AI_ASSETS.put(`${sessionKey(body.session_id)}manifest.json`, JSON.stringify(session), {
        httpMetadata: { contentType: 'application/json' },
      });
      return jsonResponse({ received: bytes.byteLength, total_chunks: session.chunkCount });
    }
  }

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') || form.get('audio');
    if (!file) return jsonResponse({ error: 'No audio file' }, 400);
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) return jsonResponse({ error: 'Empty audio' }, 400);
    if (bytes.byteLength > MAX_SESSION_BYTES) return jsonResponse({ error: 'Audio too large (max 25MB)' }, 413);
    const result = await transcribe(env, bytes, {
      model: form.get('model') || 'auto', language: form.get('language') || 'en',
    }, file.type || 'audio/webm');
    return jsonResponse({ text: result.text, model: result.model, segments: result.segments || [] });
  }

  return jsonResponse({ error: 'Unsupported content type. Use application/json or multipart/form-data.' }, 400);
}
