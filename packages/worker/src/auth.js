// API Key Authentication & Management
// Keys are stored HASHED (SHA-256) in Cloudflare KV — plaintext keys are shown once at creation.
// Key format: dvops_<id>_<secret>  → id enables direct KV lookup, secret is verified by hash.

import { contentToText } from './utils.js';

const KEY_PREFIX = 'key:';
const USAGE_PREFIX = 'usage:';
const VALID_TIERS = ['standard', 'premium'];

function randomToken(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += chars[b % chars.length];
  return out;
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Generate a new key: returns full key (shown once), its id, and the secret hash
export async function generateKey() {
  const id = 'k' + randomToken(8).toLowerCase();
  const secret = randomToken(40);
  const key = `dvops_${id}_${secret}`;
  return { id, key, key_hash: await sha256Hex(secret) };
}

// Extract API key from Authorization header
export function extractApiKey(request) {
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (auth.startsWith('dvops_')) return auth.trim();
  return null;
}

// Validate an API key against KV (hash comparison, never stores/compares plaintext)
// Short-lived in-memory cache (per isolate) skips the KV read on repeat requests,
// keeping authenticated tool traffic well under the 2s latency budget.
const KEY_CACHE = new Map(); // id -> { data, cached_at }
const KEY_CACHE_TTL_MS = 5000;

export async function validateApiKey(apiKey, env) {
  if (!apiKey || !env.API_KEYS) return null;

  const parts = apiKey.split('_');
  if (parts.length !== 3 || parts[0] !== 'dvops') return null;
  const [, id, secret] = parts;
  if (!/^k[a-z0-9]+$/.test(id)) return null;

  const cached = KEY_CACHE.get(id);
  const fresh = !!cached && Date.now() - cached.cached_at < KEY_CACHE_TTL_MS;
  const data = fresh ? cached.data : await env.API_KEYS.get(KEY_PREFIX + id, { type: 'json' });
  if (!data || data.revoked) {
    KEY_CACHE.delete(id);
    return null;
  }

  const hash = await sha256Hex(secret);
  if (!timingSafeEqual(hash, data.key_hash)) return null;

  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    KEY_CACHE.delete(id);
    return null;
  }

  if (!fresh) KEY_CACHE.set(id, { data, cached_at: Date.now() });
  return data;
}

// Track usage for a key id
export async function trackUsage(keyId, env, metadata) {
  if (!keyId || !env.API_KEYS) return;

  const today = new Date().toISOString().split('T')[0];
  const usageKey = `${USAGE_PREFIX}${keyId}:${today}`;

  try {
    const existing = await env.API_KEYS.get(usageKey, { type: 'json' });
    const usage = existing || { requests: 0, tokens: 0, models: {} };

    usage.requests += 1;
    usage.tokens += metadata.tokens || 0;
    if (metadata.model) {
      usage.models[metadata.model] = (usage.models[metadata.model] || 0) + 1;
    }

    await env.API_KEYS.put(usageKey, JSON.stringify(usage), { expirationTtl: 86400 * 7 }); // 7 days TTL
  } catch (e) {
    console.log('[Usage] tracking error:', e.message);
  }
}

// Create a new API key (admin only — enforced at route level)
export async function createApiKey(env, options = {}) {
  const { id, key, key_hash } = await generateKey();
  const name = String(options.name || 'unnamed').slice(0, 64);
  const expires_at = options.expires_at || null;
  const rate_limit = Math.max(parseInt(options.rate_limit, 10) || 0, 0);
  const tier = VALID_TIERS.includes(options.tier) ? options.tier : 'standard';

  if (expires_at && Number.isNaN(new Date(expires_at).getTime())) {
    throw new Error('expires_at must be a valid date (YYYY-MM-DD)');
  }

  const stored = {
    id,
    key_hash,
    preview: key.slice(0, 12) + '...' + key.slice(-4),
    name,
    created_at: new Date().toISOString(),
    expires_at,
    rate_limit,
    revoked: false,
    tier,
  };

  await env.API_KEYS.put(KEY_PREFIX + id, JSON.stringify(stored));

  // Full plaintext key is returned ONCE here and never persisted
  return { ...stored, key };
}

// List all API keys (admin only) — paginated, no plaintext keys
export async function listApiKeys(env) {
  if (!env.API_KEYS) return [];

  const today = new Date().toISOString().split('T')[0];
  const keys = [];
  let cursor;
  let complete = false;

  while (!complete && keys.length < 500) {
    const page = await env.API_KEYS.list({ prefix: KEY_PREFIX, cursor });
    await Promise.all(page.keys.map(async (item) => {
      const data = await env.API_KEYS.get(item.name, { type: 'json' });
      // Skip legacy pre-v3.1 entries (plaintext keys — unusable with hashed auth)
      if (!data || !data.id || !data.key_hash) return;
      const usage = await env.API_KEYS.get(`${USAGE_PREFIX}${data.id}:${today}`, { type: 'json' });
      keys.push({
        id: data.id,
        key_preview: data.preview,
        name: data.name,
        created_at: data.created_at,
        expires_at: data.expires_at,
        rate_limit: data.rate_limit,
        revoked: !!data.revoked,
        tier: data.tier,
        today_usage: usage || { requests: 0, tokens: 0, models: {} },
      });
    }));
    complete = page.list_complete === true;
    cursor = page.cursor;
  }

  return keys;
}

// Revoke an API key by exact id
export async function revokeApiKey(env, keyId) {
  const id = String(keyId || '').trim();
  if (!/^k[a-z0-9]+$/.test(id)) {
    return { success: false, error: 'Provide the exact key "id" (from GET /v1/keys)' };
  }
  if (!env.API_KEYS) return { success: false, error: 'KV binding not available' };

  const data = await env.API_KEYS.get(KEY_PREFIX + id, { type: 'json' });
  if (!data) return { success: false, error: 'Key not found' };

  data.revoked = true;
  data.revoked_at = new Date().toISOString();
  KEY_CACHE.delete(id);
  await env.API_KEYS.put(KEY_PREFIX + id, JSON.stringify(data));
  return { success: true, id: data.id, key_preview: data.preview };
}

// Delete an API key by exact id
export async function deleteApiKey(env, keyId) {
  const id = String(keyId || '').trim();
  if (!/^k[a-z0-9]+$/.test(id)) {
    return { success: false, error: 'Provide the exact key "id" (from GET /v1/keys)' };
  }
  if (!env.API_KEYS) return { success: false, error: 'KV binding not available' };

  const existing = await env.API_KEYS.get(KEY_PREFIX + id, { type: 'json' });
  if (!existing) return { success: false, error: 'Key not found' };

  KEY_CACHE.delete(id);
  await env.API_KEYS.delete(KEY_PREFIX + id);
  return { success: true, id };
}

export { contentToText };
