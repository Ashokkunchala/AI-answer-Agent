// Smart Router - Routes to best Cloudflare model based on task type

import { ROUTING_TABLE, MODELS } from './config.js';
import { classifyRequest } from './classifier.js';
import { buildSystemPrompt } from './system-prompts.js';
import { callCloudflareAI } from './providers/index.js';
import { callGateway, gatewayUsable } from './providers/gateway.js';

// AI Gateway safety-net models tried after the Workers AI chain is exhausted.
// Kept tiny (cheap during promo) and only invoked as a last resort.
const GATEWAY_FALLBACK_CHAIN = ['gpt-5.6-sol'];

// Models that recently failed with credit/quota errors are skipped inside
// routing chains for a while, so a degraded account stops paying a repeated
// ~1s dead attempt on every request. Explicitly-requested models are always
// honored (a direct ask for a model is the client's choice).
const CREDIT_COOLDOWN_MS = 10 * 60 * 1000;
const creditCooldowns = new Map();
const CREDIT_ERROR_RE = /insufficient|quota|credit|ai gateway|billing/i;

function isCreditCooledDown(modelKey) {
  const until = creditCooldowns.get(modelKey);
  if (!until) return false;
  if (until <= Date.now()) { creditCooldowns.delete(modelKey); return false; }
  return true;
}

function learnCreditCooldown(modelKey, message) {
  if (CREDIT_ERROR_RE.test(String(message || ''))) {
    creditCooldowns.set(modelKey, Date.now() + CREDIT_COOLDOWN_MS);
  }
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Helper to create a timeout promise
function timeoutPromise(ms, promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms))
  ]);
}

function getRouteChain(taskType) {
  const route = ROUTING_TABLE[taskType] || ROUTING_TABLE.general;
  return route.chains;
}

// Dispatch to the right provider based on the model's configured provider flag.
function callProvider(modelKey, messages, options, env) {
  const modelConfig = MODELS[modelKey];
  if (modelConfig?.provider === 'gateway') {
    return callGateway(modelKey, messages, options, env);
  }
  return callCloudflareAI(modelKey, messages, options, env);
}

function injectSystemPrompt(messages, taskType, customSystemPrompt, context = {}) {
  const systemContent = buildSystemPrompt(taskType, customSystemPrompt, context);
  const hasSystem = messages.some((m) => m.role === 'system');

  if (hasSystem) {
    return messages.map((m) =>
      m.role === 'system'
        ? { ...m, content: systemContent + '\n\n' + m.content }
        : m
    );
  }

  return [{ role: 'system', content: systemContent }, ...messages];
}

// body is the already-parsed request body (not a Request object)
export async function routeRequest(body, env) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) {
    throw httpError(400, '"messages" must be a non-empty array');
  }

  const options = {
    max_tokens: body.max_tokens || 0,
    temperature: body.temperature ?? 0.7,
    top_p: body.top_p,
    stream: body.stream || false,
    num_steps: body.num_steps,
    source_lang: body.source_lang,
    target_lang: body.target_lang,
  };

  // Explicit model override — unknown models are a hard error (OpenAI-compatible behavior)
  let explicitModel = null;
  if (body.model && body.model !== 'auto' && body.model !== 'devops-agent') {
    if (MODELS[body.model]) {
      explicitModel = body.model;
    } else {
      throw httpError(400, `Unknown model "${body.model}". GET /v1/models for available models.`);
    }
  }

  // Classify the request (explicit task_type override wins when valid)
  const taskType = ROUTING_TABLE[body.task_type] ? body.task_type : classifyRequest(messages);
  console.log(`[Router] Task: ${taskType} | Model: ${explicitModel || 'auto'}`);

  // Inject system prompt (skipped in raw/playground mode)
  const context = {
    resume: body.resume,
    jobDesc: body.jobDesc,
    targetName: body.targetName,
    participants: body.participants,
  };
  const enhancedMessages = body.raw
    ? messages
    : injectSystemPrompt(messages, taskType, body.system, context);

  // Get routing chain
  const chain = explicitModel
    ? [{ model: explicitModel, reason: 'explicitly requested' }]
    : getRouteChain(taskType);

  const attempts = [];

  // Try each model in the chain
  let lastError = null;
  for (const route of chain) {
    const modelKey = route.model;
    const modelConfig = MODELS[modelKey];

    if (!modelConfig) {
      attempts.push({ model: modelKey, status: 'skipped', reason: 'not found in config' });
      continue;
    }

    // Gateway models are skipped (not errors) when the gateway isn't configured,
    // so auto-routing degrades silently to Workers AI with no spurious failures.
    if (modelConfig.provider === 'gateway' && !gatewayUsable(env)) {
      attempts.push({ model: modelKey, status: 'skipped', reason: 'AI Gateway not configured' });
      continue;
    }

    // Auto-routing skips models on credit cooldown (a recent quota/credit
    // failure) so the chain falls through to a healthy model immediately.
    if (!explicitModel && isCreditCooledDown(modelKey)) {
      attempts.push({ model: modelKey, status: 'skipped', reason: 'credit cooldown active' });
      continue;
    }

    try {
      const startTime = Date.now();
      // Use per-model max_tokens when user hasn't specified one
      const modelMaxTokens = MODELS[modelKey]?.max_tokens;
      const reqOptions = {
        ...options,
        max_tokens: options.max_tokens || modelMaxTokens || 4096,
      };
      // Add timeout for individual model requests (30 seconds)
      const response = await timeoutPromise(30000, callProvider(modelKey, enhancedMessages, reqOptions, env));
      const elapsed = Date.now() - startTime;
      creditCooldowns.delete(modelKey);

      attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed });

      return {
        response,
        metadata: {
          task_type: taskType,
          task_label: ROUTING_TABLE[taskType]?.label || 'General',
          model_used: modelKey,
          model_id: modelConfig.id,
          routing_reason: route.reason,
          latency_ms: elapsed,
          all_attempts: attempts,
        },
      };
    } catch (error) {
      lastError = error;
      learnCreditCooldown(modelKey, error.message);
      attempts.push({ model: modelKey, status: 'error', error: error.message });
      console.log(`[Router] ${modelKey} failed: ${error.message}`);
    }
  }

  // ── Safety net: if every model in the chain failed and the AI Gateway is
  // configured, guarantee an answer by falling back to a premium gateway model.
  if (gatewayUsable(env)) {
    for (const modelKey of GATEWAY_FALLBACK_CHAIN) {
      const modelConfig = MODELS[modelKey];
      if (!modelConfig) continue;
      if (attempts.some((a) => a.model === modelKey)) continue; // already tried
      try {
        const startTime = Date.now();
        const fallbackMaxTokens = MODELS[modelKey]?.max_tokens || 4096;
        const response = await timeoutPromise(40000, callGateway(modelKey, enhancedMessages, {
          ...options,
          max_tokens: options.max_tokens || fallbackMaxTokens,
        }, env));
        const elapsed = Date.now() - startTime;
        attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed, fallback: true });
        return {
          response,
          metadata: {
            task_type: taskType,
            task_label: ROUTING_TABLE[taskType]?.label || 'General',
            model_used: modelKey,
            model_id: modelConfig.id,
            routing_reason: 'safety-net fallback after Workers AI chain failed',
            latency_ms: elapsed,
            all_attempts: attempts,
          },
        };
      } catch (error) {
        lastError = error;
        attempts.push({ model: modelKey, status: 'error', error: error.message, fallback: true });
        console.log(`[Router] fallback ${modelKey} failed: ${error.message}`);
      }
    }
  }

  const err = new Error(`All models failed. Last error: ${lastError?.message}`);
  err.attempts = attempts;
  throw err;
}
