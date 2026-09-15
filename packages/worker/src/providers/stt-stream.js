// STT Streaming Endpoint
// Handles real-time audio streaming for speech-to-text
// Used by the desktop app's voice service

import { transcribe } from './transcription.js';
import { concatenateChunks, base64ToBytes, jsonResponse } from '../../../../shared/utils.js';

// In-memory audio buffer per session
const sessions = new Map();

// A session that never receives its 'end' control message would otherwise leak
// forever in the module map; expire idle sessions so memory stays flat.
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSION_BYTES = 25 * 1024 * 1024;

function sweepSessions(now = Date.now()) {
  for (const [id, s] of sessions) {
    if (now - (s.lastAt || s.startTime) > SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * Handle a streaming STT request
 * Accepts chunks of audio data and returns transcription results
 */
export async function handleSTTStream(request, env) {
  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.includes('application/json')) {
    // JSON request - single audio chunk or control message
    const body = await request.json();

    // Control messages
    if (body.type === 'start') {
      sweepSessions();
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        chunks: [],
        startTime: Date.now(),
        lastAt: Date.now(),
        model: body.model || 'auto',
        language: body.language || 'en',
      });
      return jsonResponse({ session_id: sessionId, status: 'started' });
    }

    if (body.type === 'end' && body.session_id) {
      sweepSessions();
      const session = sessions.get(body.session_id);
      if (!session) return jsonResponse({ error: 'Session not found' }, 404);

      // Concatenate all chunks and transcribe
      const audioBytes = concatenateChunks(session.chunks);
      sessions.delete(body.session_id);

      if (audioBytes.byteLength === 0) {
        return jsonResponse({ text: '', error: 'No audio data' });
      }

      const result = await transcribe(env, audioBytes, {
        model: session.model,
        language: session.language,
      }, 'audio/webm');

      return jsonResponse({
        text: result.text,
        model: result.model,
        segments: result.segments || [],
        latency_ms: Date.now() - session.startTime,
      });
    }

    // Audio chunk (base64)
    if (body.audio) {
      sweepSessions();
      const sessionId = body.session_id;
      const session = sessions.get(sessionId);
      if (!session) return jsonResponse({ error: 'Session not found' }, 404);

      const bytes = base64ToBytes(body.audio);
      session.chunks.push(bytes);
      session.lastAt = Date.now();

      if (session.chunks.reduce((a, c) => a + c.byteLength, 0) > MAX_SESSION_BYTES) {
        sessions.delete(sessionId);
        return jsonResponse({ error: 'Session exceeded max audio size' }, 413);
      }

      return jsonResponse({ received: bytes.byteLength, total_chunks: session.chunks.length });
    }
  }

  // Multipart form data - single audio file upload (OpenAI compatible)
  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') || form.get('audio');
    if (!file) return jsonResponse({ error: 'No audio file' }, 400);

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) return jsonResponse({ error: 'Empty audio' }, 400);
    if (bytes.byteLength > 25 * 1024 * 1024) return jsonResponse({ error: 'Audio too large (max 25MB)' }, 413);

    const model = form.get('model') || 'auto';
    const language = form.get('language') || 'en';

    const result = await transcribe(env, bytes, { model, language }, file.type || 'audio/webm');

    return jsonResponse({
      text: result.text,
      model: result.model,
      segments: result.segments || [],
    });
  }

  return jsonResponse({ error: 'Unsupported content type. Use application/json or multipart/form-data.' }, 400);
}