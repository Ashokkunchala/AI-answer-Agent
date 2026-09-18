// Production-grade audio transcription provider.
// Exposes a single, robust entry point that:
//   - decodes audio from several input shapes (base64 string, raw bytes,
//     {audio}, multipart FormData file) into an ArrayBuffer
//   - validates MIME type + size
//   - runs the transcription model chain with per-model fallback
//   - normalizes every result into { text } (+ optional metadata)
//
// Transcriptions never carry a system prompt; each model is called directly
// with the raw audio bytes exactly as Workers AI expects.

import { MODELS } from '../config.js';

export const AUDIO_MIME_PATTERN = /^audio\/[a-z0-9.+-]+$/i;
// Matches OpenAI's practical ceiling for uploads; keeps cold-start requests sane.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB

const TRANSCRIPTION_CHAIN = ['whisper-large-v3', 'deepgram-nova-3', 'whisper'];

// ── Typed HTTP error helper ────────────────────────────────────────────────
export class TranscriptionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'TranscriptionError';
  }
}

function httpError(status, message) {
  return new TranscriptionError(status, message);
}

// ── Audio decoding ─────────────────────────────────────────────────────────
// Convert base64 -> Uint8Array
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Convert arbitrary audio input into a Uint8Array.
export function audioToBytes(audio) {
  if (audio == null) return null;
  if (typeof audio === 'string') {
    // Defensive: strip any explicit data-URI prefix the client may send.
    const cleaned = audio.replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, '');
    return b64ToBytes(cleaned);
  }
  if (audio instanceof ArrayBuffer) return new Uint8Array(audio);
  if (ArrayBuffer.isView(audio)) {
    return new Uint8Array(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
  }
  if (audio instanceof Uint8Array) return audio;
  return null;
}

function looksLikeBase64(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(value) && (value.length % 4 === 0 || value.endsWith('='));
}

// Extract + validate the raw audio bytes from an already-parsed JSON body.
// Supported shapes (OpenAI-compatible and the desktop client's legacy format):
//   { file: "<base64>" }            (desktop client)
//   { file: { ... } }               (some SDKs wrap the file object)
//   { audio: "<base64>" }           (OpenAI alt key)
//   { messages: [{ audio: ... }] }  (chat-completions style wrapper)
export function extractAudioFromJSON(body, mimeFromHeader) {
  let raw = null;
  let mime = mimeFromHeader || null;

  if (body.audio != null) {
    raw = body.audio;
    mime = mime || body.mime_type || body.format || 'audio/webm';
  } else if (body.file != null) {
    const file = body.file;
    if (file != null && typeof file === 'object' && !ArrayBuffer.isView(file) && !(file instanceof ArrayBuffer)) {
      raw = file.data ?? file.content ?? file.audio;
      mime = mime || file.mime_type || file.type || body.mime_type || 'audio/webm';
    } else {
      raw = file;
      mime = mime || body.mime_type || 'audio/webm';
    }
  } else if (Array.isArray(body.messages)) {
    const userMsg = body.messages.filter((m) => m && m.role === 'user').pop();
    const audio = userMsg && userMsg.audio;
    if (audio) {
      raw = audio;
      mime = mime || body.mime_type || (userMsg.mime_type) || 'audio/webm';
    } else if (userMsg && Array.isArray(userMsg.content)) {
      const part = userMsg.content.find((p) => p && p.type === 'audio');
      if (part) {
        raw = part.audio ?? part.data ?? part.url;
        mime = mime || part.mime_type || 'audio/webm';
      }
    }
  }

  if (raw == null) {
    throw httpError(400, 'No audio data provided. Send the audio as base64 under "file" or "audio", or upload a multipart file.');
  }

  // Strings may be base64 (decode) or already-URL/absent. Try base64 decode; if it
  // isn't valid base64 it will surface a clean validation error below.
  let bytes = null;
  if (typeof raw === 'string') {
    if (looksLikeBase64(raw)) bytes = audioToBytes(raw);
    else throw httpError(400, 'Audio payload must be base64-encoded.');
  } else {
    bytes = audioToBytes(raw);
  }
  if (!bytes || bytes.byteLength === 0) {
    throw httpError(400, 'Audio payload is empty (0 bytes).');
  }
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    throw httpError(413, `Audio file too large. Maximum allowed is ${Math.round(MAX_AUDIO_BYTES / 1024 / 1024)} MB.`);
  }
  if (mime && !AUDIO_MIME_PATTERN.test(mime)) {
    throw httpError(415, `Unsupported content type "${mime}". Must be an audio/* MIME type.`);
  }

  // Decode to a clean ArrayBuffer for the Workers AI binding.
  return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mime };
}

// Exchange binary over the wire as base64 for the Workers AI binding.
function bytesToBase64(bytes) {
  const arr = typeof bytes === 'string' ? null : bytes;
  if (!arr) return String(bytes);
  const u8 = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ── Model chain runner ─────────────────────────────────────────────────────
// Each transcription family expects a different audio shape:
//   Whisper (@cf/openai/whisper*)      -> { audio: <base64 string> }
//   Deepgram (@cf/deepgram/*)          -> { audio: { body, contentType } }
function buildModelParams(modelKey, audioBytes, mime, opts) {
  const isWhisper = /whisper/i.test(modelKey);
  const params = {};

  if (isWhisper) {
    params.audio = bytesToBase64(audioBytes);
    if (opts.language) params.language = opts.language;
    if (opts.prompt) params.initial_prompt = opts.prompt;
  } else {
    // Deepgram & other Workers AI audio models take a multipart-style body.
    params.audio = {
      body: typeof audioBytes === 'string' ? audioBytes : audioBytes,
      contentType: mime || 'audio/webm',
    };
  }
  return params;
}

function callWhisperModel(env, modelKey, audioBytes, mime, opts) {
  if (!env.AI) throw httpError(500, 'Cloudflare AI binding not available.');

  const modelId = MODELS[modelKey]?.id;
  if (!modelId) throw httpError(500, `Model "${modelKey}" not found in config.`);

  const params = buildModelParams(modelKey, audioBytes, mime, opts);
  return env.AI.run(modelId, params);
}

// Normalize a Workers AI transcription result into a canonical shape.
function normalizeResult(result, modelKey, modelId) {
  let text = '';
  let segments = null;

  if (typeof result === 'string') text = result;
  else if (result && typeof result === 'object') {
    text = result.text || result.transcription || '';
    if (Array.isArray(result.segments)) segments = result.segments;
    else if (result.words) text = text || (Array.isArray(result.words) ? result.words.map((w) => w.word).join(' ') : '');
  }

  // Some models return a bytes blob; treat as empty rather than a crash.
  if (text == null) text = '';

  return {
    text: String(text).trim(),
    segments,
    model: modelKey,
    model_id: modelId,
  };
}

function timeoutPromise(ms, promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(httpError(504, `Transcription timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run the transcription chain with automatic degradation.
export async function transcribe(env, audioBytes, opts = {}, mime = 'audio/webm') {
  const chain = Array.isArray(opts.models) && opts.models.length
    ? opts.models
    : (opts.model && opts.model !== 'auto' ? [opts.model] : TRANSCRIPTION_CHAIN);

  const attempts = [];
  let lastError = null;

  for (const modelKey of chain) {
    const modelConfig = MODELS[modelKey];
    if (!modelConfig || !modelConfig.caps?.includes('audio')) {
      attempts.push({ model: modelKey, status: 'skipped', reason: 'not an audio model' });
      continue;
    }
    try {
      const started = Date.now();
      const rawResult = await timeoutPromise(40000, callWhisperModel(env, modelKey, audioBytes, mime, opts));
      const norm = normalizeResult(rawResult, modelKey, modelConfig.id);
      attempts.push({ model: modelKey, status: 'success', latency_ms: Date.now() - started });
      return { ...norm, model: modelKey, attempts };
    } catch (e) {
      lastError = e;
      attempts.push({ model: modelKey, status: 'error', error: e.message });
    }
  }

  const err = httpError(502, `All transcription models failed. Last error: ${lastError?.message || 'unknown'}`);
  err.attempts = attempts;
  throw err;
}
