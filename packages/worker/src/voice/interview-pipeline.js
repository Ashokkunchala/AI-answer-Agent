/*
 * Voice interview pipeline primitives.
 *
 * The desktop client remains responsible for microphone capture, local DSP,
 * echo cancellation and VAD. This module keeps the Worker side stateless and
 * incremental: accept partial transcripts, detect stable text, and only send
 * stable questions to the AI router.
 */

export function normalizeTranscript(text = '') {
  return String(text).replace(/\s+/g, ' ').trim();
}

export function transcriptDelta(previous = '', current = '') {
  const prev = normalizeTranscript(previous);
  const next = normalizeTranscript(current);
  if (!next) return '';
  if (!prev) return next;
  if (next === prev) return '';
  if (next.startsWith(prev)) return next.slice(prev.length).trim();
  return next;
}

export function looksLikeCompleteInterviewQuestion(text = '') {
  const value = normalizeTranscript(text);
  if (value.length < 8) return false;
  return /[?]$/.test(value) || /\b(what|why|how|when|where|which|tell me|describe|explain|walk me through|would you)\b/i.test(value);
}

export function shouldGenerateAnswer({ previousTranscript = '', currentTranscript = '', silenceMs = 0, minSilenceMs = 550 } = {}) {
  const current = normalizeTranscript(currentTranscript);
  const delta = transcriptDelta(previousTranscript, current);
  return {
    delta,
    stable: silenceMs >= minSilenceMs,
    complete: looksLikeCompleteInterviewQuestion(current),
    ready: silenceMs >= minSilenceMs && looksLikeCompleteInterviewQuestion(current),
  };
}

export function voiceEvent(type, payload = {}) {
  return { type, timestamp: new Date().toISOString(), ...payload };
}
