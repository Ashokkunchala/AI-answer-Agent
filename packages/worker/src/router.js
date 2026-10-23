// Smart Router - Routes to best Cloudflare model based on task type

import { ROUTING_TABLE, MODELS } from './config.js';
import { classifyRequest } from './classifier.js';
import { buildSystemPrompt } from './system-prompts.js';
import { callCloudflareAI } from './providers/index.js';
import { callGateway, gatewayUsable } from './providers/gateway.js';
import { getCachedAIResponse, putCachedAIResponse, saveInterviewTurn, getInterviewContext } from './platform/cloudflare.js';
import { getBudgetState, recordSpend, planChain, modelRate, costRank, estimateCost } from './platform/budget.js';
import { buildInterviewGuardrails, answerShield, scoreAnswerHeuristically, extractQuestion } from './interview/intelligence.js';
import { resolveLiveModel, toRuntimeModel } from './model-catalog.js';

const GATEWAY_FALLBACK_CHAIN = ['gpt-5.6-sol'];
const CREDIT_COOLDOWN_MS = 10 * 60 * 1000;
const creditCooldowns = new Map();
// Also cools down unavailable models and short-lived provider failures so a
// broken route does not add the same serial delay to every request.
const CREDIT_ERROR_RE = /insufficient|quota|credit|ai gateway|billing|requires (?:a )?workers paid plan|does not have config|no such model|not allowed to use|4003|5018|5007|5035/i;

// Cloudflare Workers Free plan: the account shares a 10,000-neuron/day pool.
// When it is exhausted every Workers AI model (including free-pool models)
// fails with 4006 / "not available on the Workers Free plan" until 00:00 UTC.
// We learn this once, then skip Workers AI instantly (still trying the AI
// Gateway fallback) instead of retrying the whole chain on every request.
const FREE_ALLOCATION_ERROR_RE = /3036|4006|daily free allocation|used up your daily free allocation|not available on the workers free plan|upgrade to (?:cloudflare's )?workers paid plan/i;
// Partner models (google/*, gpt-*, kimi, deepseek-v4, ...) are served through
// AI Gateway and billed via unified billing, which needs prepaid Gateway
// credits. When the balance is empty the whole request fails even though the
// account can still serve paid Workers AI models directly.
const GATEWAY_BILLING_ERROR_RE = /insufficient ai gateway credits|gateway authentication is required|unified billing/i;
let freeAllocationBlockedUntil = 0;
export function freeAllocationBlocked() { return Date.now() < freeAllocationBlockedUntil; }
function noteFreeAllocationBlock(message) {
  if (!FREE_ALLOCATION_ERROR_RE.test(String(message || ''))) return false;
  const now = new Date();
  freeAllocationBlockedUntil = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return true;
}

function isCreditCooledDown(modelKey) {
  const until = creditCooldowns.get(modelKey);
  if (!until) return false;
  if (until <= Date.now()) { creditCooldowns.delete(modelKey); return false; }
  return true;
}
function learnModelCooldown(modelKey, message) {
  const duration = CREDIT_ERROR_RE.test(String(message || '')) ? CREDIT_COOLDOWN_MS : 30 * 1000;
  creditCooldowns.set(modelKey, Date.now() + duration);
}
export function httpError(status, message) { const err = new Error(message); err.status = status; return err; }
function timeoutPromise(ms, promise) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms))]); }
function getRouteChain(taskType) { return (ROUTING_TABLE[taskType] || ROUTING_TABLE.general).chains; }
// When the caller supplies tools, prefer models whose config advertises the
// 'tools' capability. Original ordering is preserved within each partition so
// fast models still win ties.
function orderChainForTools(chain, tools) {
  if (!tools) return chain;
  const capable = [];
  const rest = [];
  for (const route of chain) {
    const caps = MODELS[route.model]?.caps || [];
    (caps.includes('tools') ? capable : rest).push(route);
  }
  return [...capable, ...rest];
}
function withToolFlags(response) {
  if (!response || typeof response !== 'object') return response;
  const toolCalls = Array.isArray(response.tool_calls) ? response.tool_calls.filter(Boolean) : [];
  return toolCalls.length ? { ...response, tool_calls: toolCalls } : { ...response, tool_calls: [] };
}
function callProvider(modelKey, messages, options, env, modelConfig = MODELS[modelKey]) {
  return modelConfig?.provider === 'gateway' ? callGateway(modelKey, messages, options, env) : callCloudflareAI(modelKey, messages, options, env, modelConfig);
}
function injectSystemPrompt(messages, taskType, customSystemPrompt, context = {}) {
  const systemContent = buildSystemPrompt(taskType, customSystemPrompt, context);
  const interviewRules = taskType === 'interview' || taskType === 'coding' || taskType === 'system_design'
    ? buildInterviewGuardrails({ question: lastUserMessage(messages), resume: context.resume, jobDesc: context.jobDesc, taskType }) : '';
  const combined = interviewRules ? `${systemContent}\n\n${interviewRules}` : systemContent;
  const hasSystem = messages.some((m) => m.role === 'system');
  if (hasSystem) return messages.map((m) => m.role === 'system' ? { ...m, content: combined + '\n\n' + m.content } : m);
  return [{ role: 'system', content: combined }, ...messages];
}
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i]?.role === 'user') return extractQuestion(messages[i].content || '');
  return '';
}
function scheduleInterviewPersistence(env, body, taskType, response, metadata) {
  if (!body.sessionId || !env.INTERVIEW_DB || response?.type === 'stream') return;
  const answer = String(response?.content || '');
  const question = lastUserMessage(Array.isArray(body.messages) ? body.messages : []);
  saveInterviewTurn(env, { sessionId: body.sessionId, turnId: body.turnId, question, answer, taskType, model: metadata.model_used, latencyMs: metadata.latency_ms, candidateName: body.candidateName, roleTitle: body.roleTitle, company: body.company })
    .catch((error) => console.warn('[Interview] D1 persistence error:', error?.message || error));
}
function scheduleCacheWrite(env, body, taskType, response) {
  putCachedAIResponse(env, body, taskType, response).catch((error) => console.warn('[Cloudflare KV] cache write error:', error?.message || error));
}
function enrichResponse(response, body, taskType) {
  if (!response || response.type === 'stream' || !body.sessionId) return response;
  const question = lastUserMessage(body.messages || []);
  const shield = answerShield(response.content, { question, resume: body.resume, taskType });
  const quality = scoreAnswerHeuristically(question, response.content, { resume: body.resume, jobDesc: body.jobDesc });
  return { ...response, interview_quality: quality, answer_guard: shield };
}

export async function routeRequest(body, env) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) throw httpError(400, '"messages" must be a non-empty array');
  const tools = Array.isArray(body.tools) && body.tools.length ? body.tools : null;
  const options = { max_tokens: body.max_tokens || 0, temperature: body.temperature ?? 0.7, top_p: body.top_p, stream: body.stream || false, num_steps: body.num_steps, source_lang: body.source_lang, target_lang: body.target_lang, tools: tools || undefined, tool_choice: body.tool_choice };
  let explicitModel = null;
  let explicitModelConfig = null;
  if (body.model && body.model !== 'auto' && body.model !== 'devops-agent') {
    if (MODELS[body.model]) explicitModel = body.model;
    else {
      const liveModel = await resolveLiveModel(body.model, env);
      if (!liveModel) throw httpError(400, `Unknown or unsupported model "${body.model}". GET /v1/models for available text-generation models.`);
      explicitModel = body.model;
      explicitModelConfig = toRuntimeModel(liveModel);
    }
  }
  const taskType = ROUTING_TABLE[body.task_type] ? body.task_type : classifyRequest(messages);
  console.log(`[Router] Task: ${taskType} | Model: ${explicitModel || 'auto'}${tools ? ` | Tools: ${tools.length}` : ''}`);
  const persistedContext = body.sessionId && env.INTERVIEW_DB ? await getInterviewContext(env, body.sessionId, body.context_limit || 12) : [];
  const context = { resume: body.resume, jobDesc: body.jobDesc, targetName: body.targetName, participants: body.participants };
  const contextMessages = persistedContext.length ? persistedContext.flatMap((turn) => [{ role: 'user', content: `[Previous interview question] ${turn.question}` }, { role: 'assistant', content: `[Previous interview answer] ${turn.answer}` }]) : [];
  const boundedContextMessages = contextMessages.slice(-24);
  const enhancedMessages = body.raw ? messages : injectSystemPrompt([...boundedContextMessages, ...messages], taskType, body.system, context);
  // Never serve a cached answer when the caller has tools in play — responses
  // and side effects must be fresh.
  const cached = tools ? null : await getCachedAIResponse(env, body, taskType);
  if (cached?.response) {
    const cachedResponse = enrichResponse(cached.response, body, taskType);
    return { response: cachedResponse, metadata: { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: cached.response.model_used || explicitModel || 'cached', model_id: cached.response.model_id || null, routing_reason: 'Cloudflare KV cache', latency_ms: 0, all_attempts: [{ status: 'cache-hit' }], cache_hit: true } };
  }
  let budgetState = null;
  try { budgetState = await getBudgetState(env); } catch { budgetState = null; }
  const estimatedInputTokens = Math.max(1, Math.ceil(JSON.stringify(enhancedMessages).length / 4));
  const estimatedOutputTokens = options.max_tokens || budgetState?.max_output_tokens || 1024;
  const chain = explicitModel
    ? [{ model: explicitModel, reason: 'explicitly requested' }]
    : planChain(orderChainForTools(getRouteChain(taskType), tools), budgetState, {
      tools: Boolean(tools), inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens,
    });
  if (!explicitModel && budgetState) console.log(`[Budget] mode: ${budgetState.mode} | free left: ${budgetState.free_remaining}`);
  const attempts = [];
  let lastError = null;
  for (const route of chain) {
    const modelKey = route.model;
    const modelConfig = explicitModel && modelKey === explicitModel ? (explicitModelConfig || MODELS[modelKey]) : MODELS[modelKey];
    if (!modelConfig) { attempts.push({ model: modelKey, status: 'skipped', reason: 'not found in config' }); continue; }
    if (modelConfig.provider === 'gateway' && !gatewayUsable(env)) { attempts.push({ model: modelKey, status: 'skipped', reason: 'AI Gateway not configured' }); continue; }
    if (!explicitModel && isCreditCooledDown(modelKey)) { attempts.push({ model: modelKey, status: 'skipped', reason: 'credit cooldown active' }); continue; }
    // Once the account reports its daily allocation is exhausted, skip direct
    // Workers AI requests. A configured AI Gateway billing lane is tried below.
    if (modelConfig.provider !== 'gateway' && freeAllocationBlocked()) { attempts.push({ model: modelKey, status: 'skipped', reason: 'free neuron allocation exhausted (resets 00:00 UTC)' }); continue; }
    try {
      const startTime = Date.now();
      const response = await timeoutPromise(30000, callProvider(modelKey, enhancedMessages, { ...options, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 }, env, modelConfig));
      const elapsed = Date.now() - startTime;
      creditCooldowns.delete(modelKey);
      attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed });
      const cost = estimateCost(modelKey, response.usage, modelConfig);
      const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: route.reason, latency_ms: elapsed, all_attempts: attempts, estimated_cost_usd: cost.usd, model_pricing: modelConfig.pricing || null };
      const enriched = withToolFlags(enrichResponse(response, body, taskType));
      if (response.type !== 'stream') void recordSpend(env, modelKey, response.usage, modelConfig);
      if (!enriched.tool_calls?.length) {
        scheduleCacheWrite(env, body, taskType, enriched);
        scheduleInterviewPersistence(env, body, taskType, enriched, metadata);
      }
      return { response: enriched, metadata };
    } catch (error) {
      lastError = error; learnModelCooldown(modelKey, error.message); noteFreeAllocationBlock(error.message); attempts.push({ model: modelKey, status: 'error', error: error.message }); console.log(`[Router] ${modelKey} failed: ${error.message}`);
    }
  }
  // Partner models are served through AI Gateway and billed via unified
  // billing, which needs prepaid Gateway credits. When the balance is empty the
  // request would fail outright even though the account can still serve paid
  // Workers AI models directly, so degrade to the cheapest capable direct
  // model instead of returning an error.
  if (lastError && GATEWAY_BILLING_ERROR_RE.test(String(lastError.message || '')) && env.AI && budgetState?.mode !== 'blocked') {
    const seen = new Set();
    const candidates = [];
    for (const route of [...getRouteChain(taskType), ...(ROUTING_TABLE.general?.chains || [])]) {
      if (seen.has(route.model)) continue;
      seen.add(route.model);
      const cfg = MODELS[route.model];
      if (!cfg || cfg.provider === 'gateway') continue;
      if (modelRate(route.model, cfg).kind === 'pool') continue;
      if (tools && !(cfg.caps || []).includes('tools')) continue;
      candidates.push({ model: route.model, reason: route.reason, runtimeConfig: cfg });
    }
    const ordered = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => costRank(a.candidate.model, a.candidate.runtimeConfig, {
        inputTokens: estimatedInputTokens,
        outputTokens: Math.min(estimatedOutputTokens, a.candidate.runtimeConfig.max_tokens || Infinity),
        freeAllowanceRemaining: false,
      }) - costRank(b.candidate.model, b.candidate.runtimeConfig, {
        inputTokens: estimatedInputTokens,
        outputTokens: Math.min(estimatedOutputTokens, b.candidate.runtimeConfig.max_tokens || Infinity),
        freeAllowanceRemaining: false,
      }) || a.index - b.index)
      .map(({ candidate }) => candidate);

    for (const candidate of ordered) {
      const modelKey = candidate.model;
      const modelConfig = candidate.runtimeConfig;
      try {
        const startTime = Date.now();
        const response = await timeoutPromise(30000, callProvider(modelKey, enhancedMessages, { ...options, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 }, env, modelConfig));
        const elapsed = Date.now() - startTime;
        attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed, fallback: 'direct-workers-ai-after-gateway-billing-error' });
        const cost = estimateCost(modelKey, response.usage, modelConfig);
        const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: 'direct Workers AI fallback (AI Gateway unified billing unavailable)', latency_ms: elapsed, all_attempts: attempts, estimated_cost_usd: cost.usd, model_pricing: modelConfig.pricing || null };
        const enriched = withToolFlags(enrichResponse(response, body, taskType));
        if (response.type !== 'stream') void recordSpend(env, modelKey, response.usage, modelConfig);
        if (!enriched.tool_calls?.length) { scheduleCacheWrite(env, body, taskType, enriched); scheduleInterviewPersistence(env, body, taskType, enriched, metadata); }
        return { response: enriched, metadata };
      } catch (error) {
        lastError = error;
        attempts.push({ model: modelKey, status: 'error', error: error.message, fallback: true });
      }
    }
  }
  // If the account is on Workers Free, all direct models share the same daily
  // neuron cap. Retry the cheapest priced task candidate through AI Gateway's
  // unified billing lane (prepaid credits must be enabled on that gateway).
  // A gateway ID alone cannot create billing capacity, so errors are retained
  // in routing.attempts and the normal external fallback still gets a chance.
  if (freeAllocationBlocked() && env.AI_GATEWAY_ID && env.AI && budgetState?.mode !== 'blocked') {
    const fallbackRoutes = explicitModel
      ? chain.map((route) => ({ ...route, runtimeConfig: explicitModelConfig || MODELS[route.model] }))
      : chain.map((route) => ({ ...route, runtimeConfig: MODELS[route.model] }));
    const gatewayCandidates = [
      ...fallbackRoutes.filter((route) => route.runtimeConfig && route.runtimeConfig.provider !== 'gateway' && modelRate(route.model, route.runtimeConfig).kind !== 'pool'),
      ...fallbackRoutes.filter((route) => route.runtimeConfig && route.runtimeConfig.provider !== 'gateway' && modelRate(route.model, route.runtimeConfig).kind === 'pool'),
    ];
    const byPayGoCost = (routes) => routes
      .map((route, index) => ({ route, index }))
      .sort((a, b) => costRank(a.route.model, a.route.runtimeConfig, {
        inputTokens: estimatedInputTokens,
        outputTokens: Math.min(estimatedOutputTokens, a.route.runtimeConfig.max_tokens || Infinity),
        freeAllowanceRemaining: false,
      }) - costRank(b.route.model, b.route.runtimeConfig, {
        inputTokens: estimatedInputTokens,
        outputTokens: Math.min(estimatedOutputTokens, b.route.runtimeConfig.max_tokens || Infinity),
        freeAllowanceRemaining: false,
      }) || a.index - b.index)
      .map(({ route }) => route);
    // Preserve tool support when requested, then choose the lowest estimated
    // pay-as-you-go cost for this task's prompt and requested output size.
    const gatewayOrdered = tools
      ? [
          ...byPayGoCost(gatewayCandidates.filter((route) => (route.runtimeConfig.caps || []).includes('tools'))),
          ...byPayGoCost(gatewayCandidates.filter((route) => !(route.runtimeConfig.caps || []).includes('tools'))),
        ]
      : byPayGoCost(gatewayCandidates);
    for (const route of gatewayOrdered) {
      const modelKey = route.model;
      const modelConfig = route.runtimeConfig;
      try {
        const startTime = Date.now();
        const response = await timeoutPromise(30000, callProvider(
          modelKey,
          enhancedMessages,
          { ...options, gatewayId: env.AI_GATEWAY_ID, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 },
          env,
        ));
        const elapsed = Date.now() - startTime;
        attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'gateway-success', latency_ms: elapsed, fallback: true });
        const cost = estimateCost(modelKey, response.usage, modelConfig);
        const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: 'AI Gateway unified billing after daily free allocation', latency_ms: elapsed, all_attempts: attempts, estimated_cost_usd: cost.usd, model_pricing: modelConfig.pricing || null };
        const enriched = withToolFlags(enrichResponse(response, body, taskType));
        if (response.type !== 'stream') void recordSpend(env, modelKey, response.usage, modelConfig);
        if (!enriched.tool_calls?.length) { scheduleCacheWrite(env, body, taskType, enriched); scheduleInterviewPersistence(env, body, taskType, enriched, metadata); }
        return { response: enriched, metadata };
      } catch (error) {
        lastError = error;
        attempts.push({ model: modelKey, status: 'gateway-error', error: error.message, fallback: true });
      }
    }
  }
  if (gatewayUsable(env) && budgetState?.mode !== 'blocked') {
    for (const modelKey of GATEWAY_FALLBACK_CHAIN) {
      const modelConfig = MODELS[modelKey];
      if (!modelConfig || attempts.some((a) => a.model === modelKey)) continue;
      try {
        const startTime = Date.now();
        const response = await timeoutPromise(40000, callGateway(modelKey, enhancedMessages, { ...options, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 }, env));
        const elapsed = Date.now() - startTime;
        attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed, fallback: true });
        const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: 'safety-net fallback after Workers AI chain failed', latency_ms: elapsed, all_attempts: attempts };
        const enriched = withToolFlags(enrichResponse(response, body, taskType));
        if (response.type !== 'stream') void recordSpend(env, modelKey, response.usage);
        if (!enriched.tool_calls?.length) { scheduleCacheWrite(env, body, taskType, enriched); scheduleInterviewPersistence(env, body, taskType, enriched, metadata); }
        return { response: enriched, metadata };
      } catch (error) { lastError = error; attempts.push({ model: modelKey, status: 'error', error: error.message, fallback: true }); console.log(`[Router] fallback ${modelKey} failed: ${error.message}`); }
    }
  } else if (gatewayUsable(env)) {
    attempts.push({ model: GATEWAY_FALLBACK_CHAIN[0], status: 'skipped', reason: 'monthly budget limit reached' });
  }
  if (!lastError) {
    // Every candidate was skipped (never attempted): surface an actionable
    // reason instead of "All models failed. Last error: undefined".
    const blocked = freeAllocationBlocked();
    const err = httpError(503, blocked
      ? 'Cloudflare Workers AI daily free allocation is exhausted. Enable Workers Paid billing or configure prepaid credits and Unified billing on the AI Gateway to continue.'
      : 'No model candidate was reachable for this request.');
    err.attempts = attempts;
    throw err;
  }
  if (freeAllocationBlocked() && FREE_ALLOCATION_ERROR_RE.test(String(lastError.message || ''))) {
    const err = httpError(503,
      `Daily Workers AI free allocation is exhausted. The router auto-detected task "${taskType}" and tried its lowest-estimated-cost pay-as-you-go candidates, but Cloudflare billing rejected them. Enable Workers Paid billing or load AI Gateway credits and set Workers AI billing to Unified. The free allocation resets at 00:00 UTC.`);
    err.attempts = attempts;
    throw err;
  }
  const err = new Error(`All models failed. Last error: ${lastError?.message}`); err.attempts = attempts; throw err;
}
