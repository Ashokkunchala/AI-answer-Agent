// Cloudflare Workers AI Provider - All models via env.AI binding
// Normalizes every output type: text-like results get `content`, binaries get base64 `data`.

import { MODELS } from '../config.js';
import { contentToText } from '../utils.js';

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

export async function callCloudflareAI(modelKey, messages, options, env) {
  if (!env.AI) throw new Error('Cloudflare AI binding not available. Enable Workers AI in your Cloudflare dashboard.');

  const modelConfig = MODELS[modelKey];
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
      result = await env.AI.run(modelId, params);
    } catch (e) {
      // Schema mismatch — retry with minimal params
      if (/not allowed|unevaluated|required propert/i.test(e.message)) {
        result = await env.AI.run(modelId, { prompt });
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
    const result = await env.AI.run(modelId, { audio: audioInput });
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
    const result = await env.AI.run(modelId, { text: texts });
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
    const result = await env.AI.run(modelId, { text });
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
    const result = await env.AI.run(modelId, {
      text,
      source_lang: options.source_lang || 'en',
      target_lang: options.target_lang || 'es',
    });
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
      result = await env.AI.run(modelId, payload);
    } catch (e) {
      // Schema mismatch — retry with the alternate key name
      if (/required propert/i.test(e.message) && !payload.prompt) {
        result = await env.AI.run(modelId, { prompt: text });
      } else if (/not allowed|unevaluated/i.test(e.message) && payload.prompt) {
        result = await env.AI.run(modelId, { text });
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
  const aiMessages = messages.map((msg) => ({ role: msg.role, content: contentToText(msg.content) }));

  const params = {
    messages: aiMessages,
    max_tokens: options.max_tokens || 2048,
    temperature: options.temperature ?? 0.7,
    stream: options.stream || false,
  };

  if (options.top_p !== undefined) params.top_p = options.top_p;

  if (options.stream) {
    const response = await env.AI.run(modelId, params);
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
            try { yield JSON.parse(jsonStr); } catch {}
          }
        }
      },
    };
    return { type: 'stream', stream: asyncIterable, provider: 'cloudflare', model: modelKey };
  }

  const result = await env.AI.run(modelId, params);

  let content = '';
  let resp = result.response || result;

  if (typeof resp === 'string') {
    try { resp = JSON.parse(resp); } catch {}
  }

  if (resp.choices?.[0]?.message?.content) {
    content = resp.choices[0].message.content;
  } else if (typeof resp === 'string') {
    content = resp;
  } else {
    content = JSON.stringify(resp);
  }

  return {
    type: 'text',
    content,
    provider: 'cloudflare',
    model: modelKey,
    modelId,
    usage: result.usage || null,
  };
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
      response = await env.AI.run(modelId, { ...payload, stream: true });
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
    const text = await geminiText(env, modelId, payload);
    return {
      type: 'stream',
      stream: (async function* () { if (text) yield { response: text }; })(),
      provider: 'cloudflare',
      model: modelKey,
      modelId,
      stream_fallback: true,
    };
  }

  const text = await geminiText(env, modelId, payload);
  return {
    type: 'text',
    content: text,
    provider: 'cloudflare',
    model: modelKey,
    modelId,
    usage: null,
  };
}

async function geminiText(env, modelId, payload) {
  const result = await env.AI.run(modelId, payload);
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
