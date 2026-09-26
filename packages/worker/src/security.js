const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

/**
 * Small edge-safe security helpers. KV-backed enforcement can be added by
 * callers when AI_KEYS/AI_CACHE is bound; the in-memory fallback protects a
 * single isolate without making the hot path dependent on storage.
 */
const localWindows = new Map();

export function clientIdentity(request) {
  const forwarded = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  return forwarded.split(',')[0].trim() || 'unknown';
}

export function rateLimitDecision(request, limit = DEFAULT_LIMIT) {
  const key = clientIdentity(request);
  const now = Date.now();
  const current = localWindows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    localWindows.set(key, { startedAt: now, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: now + WINDOW_MS };
  }
  current.count += 1;
  return {
    allowed: current.count <= limit,
    remaining: Math.max(0, limit - current.count),
    resetAt: current.startedAt + WINDOW_MS,
  };
}

export function securityHeaders(headers = {}) {
  return {
    ...headers,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), geolocation=(), payment=()',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
}

export function rateLimitHeaders(decision) {
  return {
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(Math.ceil(decision.resetAt / 1000)),
  };
}

export function safeErrorMessage(error, fallback = 'Request failed') {
  if (!error) return fallback;
  const message = String(error.message || '');
  if (/token|secret|api[_ -]?key|authorization|credential|password/i.test(message)) return fallback;
  return message.slice(0, 500) || fallback;
}
