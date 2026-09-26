// Smart Router - Routes to best Cloudflare model based on task type

import { ROUTING_TABLE, MODELS } from './config.js';
import { classifyRequest } from './classifier.js';
import { buildSystemPrompt } from './system-prompts.js';
import { callCloudflareAI } from './providers/index.js';
import { callGateway, gatewayUsable } from './providers/gateway.js';
import { getCachedAIResponse, putCachedAIResponse, saveInterviewTurn, getInterviewContext } from './platform/cloudflare.js';
import { buildInterviewGuardrails, answerShield, scoreAnswerHeuristically, extractQuestion } from './interview/intelligence.js';

const GATEWAY_FALLBACK_CHAIN = ['gpt-5.6-sol'];
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
  if (CREDIT_ERROR_RE.test(String(message || ''))) creditCooldowns.set(modelKey, Date.now() + CREDIT_COOLDOWN_MS);
}
export function httpError(status, message) { const err = new Error(message); err.status = status; return err; }
function timeoutPromise(ms, promise) { return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Request timeout after ${ms}ms`)), ms))]); }
function getRouteChain(taskType) { return (ROUTING_TABLE[taskType] || ROUTING_TABLE.general).chains; }
function callProvider(modelKey, messages, options, env) {
  const modelConfig = MODELS[modelKey];
  return modelConfig?.provider === 'gateway' ? callGateway(modelKey, messages, options, env) : callCloudflareAI(modelKey, messages, options, env);
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
  const options = { max_tokens: body.max_tokens || 0, temperature: body.temperature ?? 0.7, top_p: body.top_p, stream: body.stream || false, num_steps: body.num_steps, source_lang: body.source_lang, target_lang: body.target_lang };
  let explicitModel = null;
  if (body.model && body.model !== 'auto' && body.model !== 'devops-agent') {
    if (MODELS[body.model]) explicitModel = body.model;
    else throw httpError(400, `Unknown model "${body.model}". GET /v1/models for available models.`);
  }
  const taskType = ROUTING_TABLE[body.task_type] ? body.task_type : classifyRequest(messages);
  console.log(`[Router] Task: ${taskType} | Model: ${explicitModel || 'auto'}`);
  const persistedContext = body.sessionId && env.INTERVIEW_DB ? await getInterviewContext(env, body.sessionId, body.context_limit || 12) : [];
  const context = { resume: body.resume, jobDesc: body.jobDesc, targetName: body.targetName, participants: body.participants };
  const contextMessages = persistedContext.length ? persistedContext.flatMap((turn) => [{ role: 'user', content: `[Previous interview question] ${turn.question}` }, { role: 'assistant', content: `[Previous interview answer] ${turn.answer}` }]) : [];
  const boundedContextMessages = contextMessages.slice(-24);
  const enhancedMessages = body.raw ? messages : injectSystemPrompt([...boundedContextMessages, ...messages], taskType, body.system, context);
  const cached = await getCachedAIResponse(env, body, taskType);
  if (cached?.response) {
    const cachedResponse = enrichResponse(cached.response, body, taskType);
    return { response: cachedResponse, metadata: { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: cached.response.model_used || explicitModel || 'cached', model_id: cached.response.model_id || null, routing_reason: 'Cloudflare KV cache', latency_ms: 0, all_attempts: [{ status: 'cache-hit' }], cache_hit: true } };
  }
  const chain = explicitModel ? [{ model: explicitModel, reason: 'explicitly requested' }] : getRouteChain(taskType);
  const attempts = [];
  let lastError = null;
  for (const route of chain) {
    const modelKey = route.model;
    const modelConfig = MODELS[modelKey];
    if (!modelConfig) { attempts.push({ model: modelKey, status: 'skipped', reason: 'not found in config' }); continue; }
    if (modelConfig.provider === 'gateway' && !gatewayUsable(env)) { attempts.push({ model: modelKey, status: 'skipped', reason: 'AI Gateway not configured' }); continue; }
    if (!explicitModel && isCreditCooledDown(modelKey)) { attempts.push({ model: modelKey, status: 'skipped', reason: 'credit cooldown active' }); continue; }
    try {
      const startTime = Date.now();
      const response = await timeoutPromise(30000, callProvider(modelKey, enhancedMessages, { ...options, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 }, env));
      const elapsed = Date.now() - startTime;
      creditCooldowns.delete(modelKey);
      attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed });
      const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: route.reason, latency_ms: elapsed, all_attempts: attempts };
      const enriched = enrichResponse(response, body, taskType);
      scheduleCacheWrite(env, body, taskType, enriched);
      scheduleInterviewPersistence(env, body, taskType, enriched, metadata);
      return { response: enriched, metadata };
    } catch (error) {
      lastError = error; learnCreditCooldown(modelKey, error.message); attempts.push({ model: modelKey, status: 'error', error: error.message }); console.log(`[Router] ${modelKey} failed: ${error.message}`);
    }
  }
  if (gatewayUsable(env)) {
    for (const modelKey of GATEWAY_FALLBACK_CHAIN) {
      const modelConfig = MODELS[modelKey];
      if (!modelConfig || attempts.some((a) => a.model === modelKey)) continue;
      try {
        const startTime = Date.now();
        const response = await timeoutPromise(40000, callGateway(modelKey, enhancedMessages, { ...options, max_tokens: options.max_tokens || modelConfig.max_tokens || 4096 }, env));
        const elapsed = Date.now() - startTime;
        attempts.push({ model: modelKey, modelId: modelConfig.id, status: 'success', latency_ms: elapsed, fallback: true });
        const metadata = { task_type: taskType, task_label: ROUTING_TABLE[taskType]?.label || 'General', model_used: modelKey, model_id: modelConfig.id, routing_reason: 'safety-net fallback after Workers AI chain failed', latency_ms: elapsed, all_attempts: attempts };
        const enriched = enrichResponse(response, body, taskType);
        scheduleCacheWrite(env, body, taskType, enriched); scheduleInterviewPersistence(env, body, taskType, enriched, metadata);
        return { response: enriched, metadata };
      } catch (error) { lastError = error; attempts.push({ model: modelKey, status: 'error', error: error.message, fallback: true }); console.log(`[Router] fallback ${modelKey} failed: ${error.message}`); }
    }
  }
  const err = new Error(`All models failed. Last error: ${lastError?.message}`); err.attempts = attempts; throw err;
}
