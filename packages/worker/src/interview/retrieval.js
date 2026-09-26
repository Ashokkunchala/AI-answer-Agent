const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_TOP_K = 6;

function normalizeText(value, max = 6000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function vectorizeAvailable(env) {
  return Boolean(env?.VECTORIZE && env?.AI);
}

export async function embedText(env, text) {
  if (!vectorizeAvailable(env)) return null;
  const input = normalizeText(text);
  if (!input) return null;
  const result = await env.AI.run(EMBEDDING_MODEL, { text: [input] });
  return result?.data?.[0] || null;
}

export async function retrieveInterviewContext(env, query, options = {}) {
  if (!vectorizeAvailable(env)) return [];
  const vector = await embedText(env, query);
  if (!vector) return [];

  const topK = Math.min(Math.max(Number(options.topK || DEFAULT_TOP_K), 1), 12);
  const result = await env.VECTORIZE.query(vector, {
    topK,
    returnMetadata: 'all',
  });

  return (result?.matches || []).map((match) => ({
    id: match.id,
    score: Number(match.score || 0),
    metadata: match.metadata || {},
  }));
}

export async function indexInterviewDocument(env, { id, text, type = 'document', sessionId = '' }) {
  if (!vectorizeAvailable(env) || !id) return { indexed: false, reason: 'vectorize_unavailable' };
  const cleanText = normalizeText(text);
  if (!cleanText) return { indexed: false, reason: 'empty_text' };
  const vector = await embedText(env, cleanText);
  if (!vector) return { indexed: false, reason: 'embedding_failed' };

  await env.VECTORIZE.upsert([{
    id: String(id),
    values: vector,
    metadata: {
      type,
      session_id: String(sessionId || ''),
      text: cleanText,
    },
  }]);

  return { indexed: true, id: String(id), model: EMBEDDING_MODEL };
}

export function formatRetrievedContext(matches, maxChars = 7000) {
  let output = '';
  for (const match of matches || []) {
    const text = normalizeText(match?.metadata?.text, 1800);
    if (!text) continue;
    const block = `[${match.metadata.type || 'context'} | score=${match.score.toFixed(3)}]\n${text}\n`;
    if ((output + block).length > maxChars) break;
    output += block;
  }
  return output.trim();
}
