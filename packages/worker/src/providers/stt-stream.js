// STT Streaming Endpoint
// Handles real-time audio streaming for speech-to-text
// Used by the desktop app's voice service

import { transcribe } from './transcription.js';
import { concatenateChunks, base64ToBytes, jsonResponse } from '../../../../shared/utils.js';

// In-memory audio buffer per session
const sessions = new Map();

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
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        chunks: [],
        startTime: Date.now(),
        model: body.model || 'auto',
        language: body.language || 'en',
      });
      return jsonResponse({ session_id: sessionId, status: 'started' });
    }

    if (body.type === 'end' && body.session_id) {
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
      const sessionId = body.session_id;
      const session = sessions.get(sessionId);
      if (!session) return jsonResponse({ error: 'Session not found' }, 404);

      const bytes = base64ToBytes(body.audio);
      session.chunks.push(bytes);

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