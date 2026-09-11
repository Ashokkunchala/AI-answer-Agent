// Cloudflare AI Gateway Provider - OpenAI-compatible REST API via fetch
// Lets the agent use premium models (e.g. gpt-5.6-sol) through AI Gateway
// directly. Billed through AI Gateway unified billing, NOT Workers AI.
//
// Requires two secrets/wr vars on the worker:
//   GATEWAY_ACCOUNT_ID  - your Cloudflare account ID (24 hex chars)
//   GATEWAY_API_TOKEN   - a Cloudflare API token with AI Gateway permissions
//                         (or GATEWAY_API_KEY for the legacy /v1 endpoint key)
//
// If neither is configured this provider is simply skipped at runtime.

import { contentToText } from '../utils.js';

const DEFAULT_TIMEOUT_MS = 30000;

function config(env) {
  const accountId = env.GATEWAY_ACCOUNT_ID;
  const token = env.GATEWAY_API_TOKEN;
  const apiKey = env.GATEWAY_API_KEY;
  if (!accountId) return null;
  // Prefer the env-var token, fall back to the API key secret
  const credential = token || apiKey;
  if (!credential) return null;
  // Optional gateway name (defaults to "self-hosted-openai" style endpoint)
  const gatewayName = env.GATEWAY_NAME || 'generic';
  return { accountId, credential, gatewayName };
}

// Returns a valid chat-completions URL or null when gateway isn't configured.
export function gatewayUsable(env) {
  return !!config(env);
}

// Strip out non-text parts (images, tool results, etc.) before sending to a
// text-only gateway model. Keeps messages shallow & fast.
function toChatMessages(messages) {
  return messages
    .filter((m) => !m.hidden)
    .map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
      return { role, content: contentToText(m.content) };
    });
}

// Main entry: normalized result matching the Workers AI provider shape.
export async function callGateway(modelKey, messages, options, env) {
  const cfg = config(env);
  if (!cfg) throw new Error('AI Gateway not configured (GATEWAY_ACCOUNT_ID + GATEWAY_API_TOKEN/KEY)');

  const accountId = cfg.accountId;
  const credential = cfg.credential;

  const url = `https://gateway.ai.cloudflare.com/v1/${accountId}/${cfg.gatewayName}/openai/chat/completions`;

  const payload = {
    model: modelKey,
    messages: toChatMessages(messages),
    max_tokens: options.max_tokens || 4096,
    temperature: options.temperature ?? 0.7,
    stream: !!options.stream,
  };
  if (options.top_p !== undefined) payload.top_p = options.top_p;

  // Gateway supports a `cf` metadata object (e.g. for caching policy).
  // If the caller opted in to prompt caching, mirror that request to the gateway.
  if (options.gateway_cache) {
    payload.cf = { cacheTtl: options.gateway_cache };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential}`,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout_ms || DEFAULT_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`AI Gateway request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = await response.text();
      detail = typeof errBody === 'string' && errBody ? errBody.slice(0, 400) : '';
    } catch {}
    throw new Error(`AI Gateway returned ${response.status}: ${detail}`);
  }

  if (options.stream) {
    const body = response.body;
    if (!body) throw new Error('AI Gateway stream returned no body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const asyncIterable = {
      async *[Symbol.asyncIterator]() {
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t || !t.startsWith('data: ')) continue;
            const jsonStr = t.slice(6);
            if (jsonStr === '[DONE]') return;
            try {
              const chunk = JSON.parse(jsonStr);
              const text = chunk.choices?.[0]?.delta?.content || '';
              if (text) yield { type: 'text', content: text };
            } catch {}
          }
        }
      },
    };
    return { type: 'stream', stream: asyncIterable, provider: 'gateway', model: modelKey };
  }

  const data = await response.json();
  let content = data.choices?.[0]?.message?.content ?? '';
  if (Array.isArray(content)) {
    content = content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }

  return {
    type: 'text',
    content,
    provider: 'gateway',
    model: modelKey,
    usage: data.usage || null,
  };
}
