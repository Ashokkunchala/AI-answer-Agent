// Cloudflare Workers AI Provider - All models via env.AI binding
// Normalizes every output type: text-like results get `content`, binaries get base64 `data`.

import { MODELS } from '../config.js';
import { contentToText } from '../utils.js';

function runAI(env, modelId, input, options = {}) {
  const gatewayId = options.gatewayId;
  return gatewayId
    ? env.AI.run(modelId, input, { gateway: { id: gatewayId } })
    : env.AI.run(modelId, input);
}

function lastMessage(messages) {
  return messages.filter((m) => m.role === 'user').pop() || null;
}

function lastUserText(messages) {
  const msg = lastMessage(messages);
  return msg ? contentToText(msg.content) : '';
}

// Convert ReadableStream / ArrayBuffer / Uint8Array to base64 string
async function toBase64(value) {
  if (typeof value === 'string') return value; // assume already base64
  let buffer;
  if (value instanceof ArrayBuffer) buffer = value;
  else if (ArrayBuffer.isView(value)) buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  else if (value && typeof value.getReader === 'function') buffer = await new Response(value).arrayBuffer();
  else return null;

  const bytes = new Uint8Array(buffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Decode base64 to bytes (for audio inputs)
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Normalize a single tool call from any provider shape into the OpenAI
// function-calling shape: { id, type:'function', function:{ name, arguments } }.
function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const fn = tc.function || tc;
  const name = fn.name || tc.name || '';
  if (!name) return null;
  let args = fn.arguments ?? tc.arguments ?? {};
  const argsString = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return {
    id: tc.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name, arguments: argsString },
  };
}

// Extract an array of normalized tool calls from any Workers AI / OpenAI
// response object. Checks every shape we've seen in the wild.
function extractToolCalls(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const candidates = [
    payload.tool_calls,
    payload.response?.tool_calls,
    payload.choices?.[0]?.message?.tool_calls,
    payload.choices?.[0]?.delta?.tool_calls,
    payload.message?.tool_calls,
    payload.result?.tool_calls,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate) || !candidate.length) continue;
    const normalized = candidate.map(normalizeToolCall).filter(Boolean);
    if (normalized.length) return normalized;
  }
  return [];
}

// Pull the assistant text out of any Workers AI response shape.
function extractText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  const candidates = [
    payload.response,
    payload.text,
    payload.content,
    payload.choices?.[0]?.message?.content,
    payload.choices?.[0]?.delta?.content,
    payload.message?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
    if (Array.isArray(candidate)) {
      const joined = candidate.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
      if (joined) return joined;
    }
  }
  // Reasoning-only responses (content empty) — surface the thinking text rather
  // than an empty answer.
  const reasoning = [
    payload.choices?.[0]?.message?.reasoning_content,
    payload.choices?.[0]?.delta?.reasoning_content,
    payload.reasoning_content,
    payload.reasoning,
    payload.message?.reasoning_content,
  ];
  for (const candidate of reasoning) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return '';
}

// Preserve OpenAI function-calling fields when forwarding messages to Workers AI.
function toAIMessage(msg) {
  const out = { role: msg.role, content: contentToText(msg.content) };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) out.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.name) out.name = msg.name;
  return out;
}

export async function callCloudflareAI(modelKey, messages, options, env, modelConfigOverride = null) {
  if (!env.AI) throw new Error('Cloudflare AI binding not available. Enable Workers AI in your Cloudflare dashboard.');

  const modelConfig = modelConfigOverride || MODELS[modelKey];
  if (!modelConfig) throw new Error(`Unknown model: ${modelKey}`);

  const modelId = modelConfig.id;
  const caps = modelConfig.caps || [];

  // Google (Gemini) run-catalog models use a native contents/systemInstruction
  // wire format — dispatch them before the generic paths.
  if (modelConfig.wire === 'gemini') {
    return callGeminiAI(modelKey, messages, options, env, modelId);
  }

  // ── Image generation ──
  if (caps.includes('image')) {
    const prompt = lastUserText(messages);
    if (!prompt) throw new Error('Prompt required for image generation');

    const params = { prompt };
    if (options.num_steps) {
      // flux family uses `steps`; SDXL/others use `num_steps`
      if (/flux/i.test(modelId)) params.steps = options.num_steps;
      else params.num_steps = options.num_steps;
    }

    let result;
    try {
      result = await runAI(env, modelId, params, options);
    } catch (e) {
      // Schema mismatch — retry with minimal params
      if (/not allowed|unevaluated|required propert/i.test(e.message)) {
        result = await runAI(env, modelId, { prompt }, options);
      } else throw e;
    }

    let data = null;
    let mime_type = 'image/png';
    if (result && typeof result === 'object' && !(result instanceof ReadableStream)) {
      mime_type = result.mime_type || mime_type;
      data = await toBase64(result.image || result.img || result.base64);
    }
    if (!data) data = await toBase64(result);
    if (!data) throw new Error('Image generation returned no data');

    return { type: 'image', content: '[Image generated]', data, mime_type, provider: 'cloudflare', model: modelKey };
  }

  // ── Audio transcription ──
  if (caps.includes('audio')) {
    const msg = lastMessage(messages);
    const audio = msg?.audio;
    if (!audio) throw new Error('Audio data required for transcription models (set "audio" on the user message)');
    const audioInput = typeof audio === 'string' ? b64ToBytes(audio) : audio;
    const result = await runAI(env, modelId, { audio: audioInput }, options);
    const text = typeof result === 'string' ? result : (result.text || JSON.stringify(result));
    return { type: 'audio', content: text, provider: 'cloudflare', model: modelKey };
  }

  // ── Embeddings ──
  if (caps.includes('embeddings')) {
    const texts = messages
      .filter((m) => m.role === 'user')
      .map((m) => contentToText(m.content))
      .filter(Boolean);
    if (!texts.length) throw new Error('Text required for embedding models');
    const result = await runAI(env, modelId, { text: texts }, options);
    return {
      type: 'embeddings',
      content: `[Embeddings: ${texts.length} input(s)]`,
      data: result.data || result,
      shape: result.shape,
      provider: 'cloudflare',
      model: modelKey,
    };
  }

  // ── Classification ──
  if (caps.includes('classification')) {
    const text = lastUserText(messages);
    if (!text) throw new Error('Text required for classification models');
    const result = await runAI(env, modelId, { text }, options);
    return {
      type: 'classification',
      content: JSON.stringify(result),
      raw: result,
      provider: 'cloudflare',
      model: modelKey,
    };
  }

  // ── Translation ──
  if (caps.includes('translation')) {
    const text = lastUserText(messages);
    if (!text) throw new Error('Text required for translation models');
    const result = await runAI(env, modelId, {
      text,
      source_lang: options.source_lang || 'en',
      target_lang: options.target_lang || 'es',
    }, options);
    const translated = typeof result === 'string' ? result : (result.translated_text || result.translation || JSON.stringify(result));
    return { type: 'translation', content: translated, provider: 'cloudflare', model: modelKey };
  }

  // ── Text-to-speech ──
  if (caps.includes('tts')) {
    const text = lastUserText(messages);
    if (!text) throw new Error('Text required for TTS models');

    // melotts takes `prompt`; deepgram aura takes `text`
    const payload = /melotts/i.test(modelId) ? { prompt: text } : { text };
    let result;
    try {
      result = await runAI(env, modelId, payload, options);
    } catch (e) {
      // Schema mismatch — retry with the alternate key name
      if (/required propert/i.test(e.message) && !payload.prompt) {
        result = await runAI(env, modelId, { prompt: text }, options);
      } else if (/not allowed|unevaluated/i.test(e.message) && payload.prompt) {
        result = await runAI(env, modelId, { text }, options);
      } else throw e;
    }

    let data = null;
    let mime_type = 'audio/mp3';
    if (result && typeof result === 'object' && !(result instanceof ReadableStream)) {
      mime_type = result.mime_type || mime_type;
      data = await toBase64(result.audio || result.base64);
    }
    if (!data) data = await toBase64(result);
    if (!data) throw new Error('TTS returned no audio data');
    return { type: 'tts', content: '[Speech generated]', data, mime_type, provider: 'cloudflare', model: modelKey };
  }

  // ── Default: text generation (chat) ──
  const aiMessages = messages.map(toAIMessage);

  const params = {
    messages: aiMessages,
    max_tokens: options.max_tokens || 2048,
    temperature: options.temperature ?? 0.7,
    stream: options.stream || false,
  };

  if (options.top_p !== undefined) params.top_p = options.top_p;
  if (Array.isArray(options.tools) && options.tools.length) {
    params.tools = options.tools;
    if (options.tool_choice) params.tool_choice = options.tool_choice;
  }

  // Tool calling is usually only reliable in buffered (non-stream) mode for
  // Workers AI: streamed tool calls frequently arrive with empty `arguments`.
  // So whenever tools are in play we take the buffered path to obtain correct
  // arguments, then re-emit the result as a single SSE chunk (see below) so
  // streaming callers still receive a well-formed stream.
  const hasTools = Array.isArray(params.tools) && params.tools.length > 0;
  const useStream = options.stream && !hasTools;

  if (useStream) {
    let response = null;
    try {
      response = await runAI(env, modelId, params, options);
      if (response && typeof response.getReader !== 'function') {
        // Model answered with a buffered object even though we asked to stream.
        response = { buffered: response };
      }
    } catch (e) {
      // Not all tool-capable models accept stream+tools — fall back to buffered.
      if (!params.tools) throw e;
      console.log(`[Providers] ${modelKey} stream+tools failed (${e.message}); falling back to buffered mode`);
      response = null;
    }

    if (response?.buffered) {
      const raw = response.buffered;
      const toolCalls = extractToolCalls(raw);
      const content = extractText(raw?.response ?? raw);
      const chunk = { response: content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      const single = {
        async *[Symbol.asyncIterator]() {
          yield chunk;
        },
      };
      return { type: 'stream', stream: single, provider: 'cloudflare', model: modelKey, modelId, stream_fallback: true };
    }

    if (response) {
      const reader = response.getReader();
      const textDecoder = new TextDecoder();
      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') return;
              let parsed;
              try { parsed = JSON.parse(jsonStr); } catch { continue; }
              const text = extractText(parsed);
              const toolCalls = extractToolCalls(parsed);
              if (text || toolCalls.length) {
                yield { response: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
              }
            }
          }
        },
      };
      return { type: 'stream', stream: asyncIterable, provider: 'cloudflare', model: modelKey, modelId };
    }
    // Streaming failed and tools are in play: drop through to buffered mode.
    params.stream = false;
  }

  const rawParams = params.tools ? { ...params, stream: false } : params;
  const result = await runAI(env, modelId, rawParams, options);

  let resp = result?.response ?? result;
  if (typeof resp === 'string') {
    try { resp = JSON.parse(resp); } catch {}
  }

  const toolCalls = extractToolCalls(result);
  if (!toolCalls.length && resp && resp !== result) {
    toolCalls.push(...extractToolCalls(resp));
  }

  let content = '';
  if (toolCalls.length) {
    content = extractText(resp) || (typeof resp === 'string' ? resp : '');
  } else if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    // Some models answer with an OpenAI-shaped completion (`choices[]`) whose
    // message may only carry `reasoning_content`, or an empty string. Detect
    // the completion shape (not just truthy content) so we never stringify the
    // whole envelope into the answer.
    const isCompletion =
      Array.isArray(resp.choices) ||
      resp.response !== undefined ||
      resp.text !== undefined ||
      resp.content !== undefined ||
      resp.type === 'text';
    content = isCompletion ? extractText(resp) : JSON.stringify(resp);
  } else if (typeof resp === 'string') {
    content = resp;
  } else {
    content = JSON.stringify(resp);
  }

  const buffered = {
    type: 'text',
    content,
    tool_calls: toolCalls,
    provider: 'cloudflare',
    model: modelKey,
    modelId,
    usage: result?.usage || null,
  };

  // The caller asked for a stream (and tools are present): re-emit the buffered
  // result as a single SSE chunk so tool arguments stay intact end to end.
  if (options.stream) {
    const chunk = { response: content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
    const single = {
      async *[Symbol.asyncIterator]() {
        yield chunk;
      },
    };
    return { type: 'stream', stream: single, provider: 'cloudflare', model: modelKey, modelId };
  }

  return buffered;
}

// ── Google (Gemini) native wire format via env.AI.run ──
// Gemini catalog models expect `contents` (+ `systemInstruction`) and return
// `candidates[].content.parts[]`, not OpenAI-style messages/choices. Outputs
// are normalized to the same {type:'text'|'stream'} shape the router expects.
async function callGeminiAI(modelKey, messages, options, env, modelId) {
  if (!env.AI) throw new Error('Cloudflare AI binding not available for Gemini.');

  const systemParts = [];
  const contents = [];
  for (const m of messages || []) {
    const text = contentToText(m.content);
    if (!text) continue;
    if (m.role === 'system') {
      systemParts.push(text);
    } else {
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text }] });
    }
  }
  if (!contents.length) throw new Error('"messages" must contain a user/assistant message');

  const payload = { contents };
  if (systemParts.length) payload.systemInstruction = { parts: systemParts.map((text) => ({ text })) };
  const generationConfig = {};
  if (options.temperature !== undefined && options.temperature !== 0) generationConfig.temperature = options.temperature;
  if (options.top_p !== undefined) generationConfig.topP = options.top_p;
  const maxOutputTokens = options.max_tokens || 2048;
  if (maxOutputTokens > 0) generationConfig.maxOutputTokens = maxOutputTokens;
  if (Object.keys(generationConfig).length) payload.generationConfig = generationConfig;

  if (options.stream) {
    let response = null;
    try {
      response = await runAI(env, modelId, { ...payload, stream: true }, options);
    } catch (_) {
      response = null; // model/binding without streaming — fall back below
    }
    if (response && typeof response.getReader === 'function') {
      // Streaming SSE from the binding (normalized chunks); yield deltas.
      const reader = response.getReader();
      const textDecoder = new TextDecoder();
      const asyncIterable = {
        async *[Symbol.asyncIterator]() {
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += textDecoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const jsonStr = trimmed.slice(6);
              if (jsonStr === '[DONE]') return;
              try {
                const j = JSON.parse(jsonStr);
                const text = j.response || j.text || j.content || j.choices?.[0]?.delta?.content || '';
                if (text) yield { response: text };
              } catch {}
            }
          }
        },
      };
      return { type: 'stream', stream: asyncIterable, provider: 'cloudflare', model: modelKey, modelId };
    }
    // No native streaming: emit the assembled answer as one stream chunk so the
    // router/SSE contract still holds (latency reporting reflects actual
    // generation, not a fabricated token stream).
    const text = await geminiText(env, modelId, payload, options);
    return {
      type: 'stream',
      stream: (async function* () { if (text) yield { response: text }; })(),
      provider: 'cloudflare',
      model: modelKey,
      modelId,
      stream_fallback: true,
    };
  }

  const text = await geminiText(env, modelId, payload, options);
  return {
    type: 'text',
    content: text,
    provider: 'cloudflare',
    model: modelKey,
    modelId,
    usage: null,
  };
}

async function geminiText(env, modelId, payload, options = {}) {
  const result = await runAI(env, modelId, payload, options);
  if (typeof result === 'string') {
    try { return JSON.parse(result).candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || result; }
    catch (_) { return result; }
  }
  if (result.candidates?.[0]?.content?.parts?.length) {
    return result.candidates[0].content.parts.map((p) => p.text || '').join('');
  }
  if (result.text) return result.text;
  if (result.response) return result.response;
  if (result.choices?.[0]?.message?.content) return result.choices[0].message.content;
  return JSON.stringify(result);
}
