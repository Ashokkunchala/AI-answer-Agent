// Cloudflare Workers AI - All models via env.AI.run()
// No external API keys needed. Just enable Workers AI in dashboard.

export const VERSION = '4.0.0';

export const MODELS = {
  // AI GATEWAY (Premium - optional, requires GATEWAY_ACCOUNT_ID + GATEWAY_API_TOKEN/KEY)
  // Billed via AI Gateway unified billing (promo pricing on gpt-5.6-sol).
  'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', params: 'sol', context: 128000, max_tokens: 16384, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','review','code_gen','debug','general'], provider: 'gateway' },

  // FLAGSHIP TEXT (Best Quality)
  'gpt-oss-120b': { id: '@cf/openai/gpt-oss-120b', name: 'GPT OSS 120B', params: '120B', context: 128000, max_tokens: 16384, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','debug','review','explain'] },
  'gpt-oss-20b': { id: '@cf/openai/gpt-oss-20b', name: 'GPT OSS 20B', params: '20B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['quick_qa','general','explain'] },
  'nemotron-120b': { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 120B', params: '120B', context: 256000, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','debug','review'] },
  'kimi-k2.7-code': { id: '@cf/moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code', params: '7B', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming','vision'], bestFor: ['code_gen','debug','deep_reasoning'] },
  'kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', params: '1T', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming','vision'], bestFor: ['code_gen','explain','general'] },
  'llama-3.3-70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', params: '70B', context: 24000, max_tokens: 8192, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','explain','mentor'] },
  'llama-4-scout': { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', params: '17B', context: 131000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming','vision'], bestFor: ['general','quick_qa','explain'] },
  'deepseek-r1-32b': { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B', params: '32B', context: 80000, max_tokens: 16384, speed: 'medium', caps: ['reasoning','streaming'], bestFor: ['debug','deep_reasoning','review'] },
  'deepseek-v4-flash': { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', params: 'MoE', context: 1310720, max_tokens: 32768, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','explain'] },
  'deepseek-v4-pro': { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', params: 'MoE', context: 1048576, max_tokens: 32768, speed: 'medium', caps: ['tools','streaming'], bestFor: ['deep_reasoning','debug','review'] },
  'gemma-4-26b': { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B', params: '26B', context: 256000, max_tokens: 32768, speed: 'fast', caps: ['tools','streaming','reasoning','vision'], bestFor: ['general','explain','code_gen'] },
  'mistral-small-24b': { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 24B', params: '24B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','code_gen'] },
  'granite-4.0': { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0', params: 'MoE', context: 131000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','explain'] },
  'glm-5.2': { id: '@cf/zai-org/glm-5.2', name: 'GLM 5.2', params: 'MoE', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['code_gen','deep_reasoning','debug'] },
  'glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM 4.7 Flash', params: 'MoE', context: 131072, max_tokens: 16384, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['quick_qa','general','explain'] },
  'qwen3.8-27b': { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', params: '27B', context: 262144, max_tokens: 32768, speed: 'fast', caps: ['tools','reasoning','streaming','vision'], bestFor: ['general','explain','code_gen'] },
  'sea-lion-27b': { id: '@cf/aisingapore/gemma-sea-lion-v4-27b-it', name: 'SEA-LION 27B', params: '27B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['streaming'], bestFor: ['general','explain'] },

  // CODE-SPECIFIC
  'qwen-coder-32b': { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen Coder 32B', params: '32B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['streaming'], bestFor: ['code_gen','scripting'] },
  'qwq-32b': { id: '@cf/qwen/qwq-32b', name: 'QwQ 32B', params: '32B', context: 24000, max_tokens: 8192, speed: 'medium', caps: ['reasoning','streaming'], bestFor: ['deep_reasoning','debug'] },
  'qwen3-30b': { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen 3 30B', params: '30B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['code_gen','general','scripting'] },

  // FAST (Low Latency)
  'llama-3.1-8b': { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B', params: '8B', context: 32000, max_tokens: 4096, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa','general'] },
  'llama-3.2-3b': { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B', params: '3B', context: 80000, max_tokens: 4096, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa'] },
  'llama-3.2-1b': { id: '@cf/meta/llama-3.2-1b-instruct', name: 'Llama 3.2 1B', params: '1B', context: 60000, max_tokens: 2048, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa'] },

  // VISION
  'llama-3.2-11b-vision': { id: '@cf/meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision', params: '11B', context: 128000, max_tokens: 8192, speed: 'fast', caps: ['vision','streaming'], bestFor: ['vision','explain'] },
  'moondream-9b': { id: '@cf/moondream/moondream3.1-9B-A2B', name: 'Moondream 3.1', params: '9B', context: null, max_tokens: 4096, speed: 'fast', caps: ['vision'], bestFor: ['vision'] },

  // SAFETY
  'llama-guard-3': { id: '@cf/meta/llama-guard-3-8b', name: 'Llama Guard 3', params: '8B', context: 131072, max_tokens: 4096, speed: 'fast', caps: ['streaming'], bestFor: ['safety'] },

  // IMAGE GENERATION
  'flux-2-dev': { id: '@cf/black-forest-labs/flux-2-dev', name: 'FLUX 2 Dev', speed: 'medium', caps: ['image'], bestFor: ['image_gen'] },
  'flux-2-klein-9b': { id: '@cf/black-forest-labs/flux-2-klein-9b', name: 'FLUX 2 Klein 9B', speed: 'fast', caps: ['image'], bestFor: ['image_gen'] },
  'flux-2-klein-4b': { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX 2 Klein 4B', speed: 'fastest', caps: ['image'], bestFor: ['image_gen'] },
  'flux-1-schnell': { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX 1 Schnell', speed: 'fastest', caps: ['image'], bestFor: ['image_gen'] },
  'sdxl': { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base', speed: 'medium', caps: ['image'], bestFor: ['image_gen'] },
  'sdxl-lightning': { id: '@cf/bytedance/stable-diffusion-xl-lightning', name: 'SDXL Lightning', speed: 'fast', caps: ['image'], bestFor: ['image_gen'] },
  'dreamshaper': { id: '@cf/lykon/dreamshaper-8-lcm', name: 'Dreamshaper 8', speed: 'fast', caps: ['image'], bestFor: ['image_gen'] },
  'lucid-origin': { id: '@cf/leonardo/lucid-origin', name: 'Lucid Origin', speed: 'fast', caps: ['image'], bestFor: ['image_gen'] },
  'phoenix-1.0': { id: '@cf/leonardo/phoenix-1.0', name: 'Phoenix 1.0', speed: 'fast', caps: ['image'], bestFor: ['image_gen'] },

  // AUDIO
  'whisper-large-v3': { id: '@cf/openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo', speed: 'medium', caps: ['audio'], bestFor: ['transcription'] },
  'whisper': { id: '@cf/openai/whisper', name: 'Whisper', speed: 'medium', caps: ['audio'], bestFor: ['transcription'] },
  'whisper-tiny': { id: '@cf/openai/whisper-tiny-en', name: 'Whisper Tiny', speed: 'fastest', caps: ['audio'], bestFor: ['transcription'] },
  'deepgram-nova-3': { id: '@cf/deepgram/nova-3', name: 'Deepgram Nova 3', speed: 'fast', caps: ['audio'], bestFor: ['transcription'] },
  'deepgram-flux': { id: '@cf/deepgram/flux', name: 'Deepgram Flux', speed: 'fast', caps: ['audio'], bestFor: ['transcription'] },
  'tts-aura-1': { id: '@cf/deepgram/aura-1', name: 'Aura TTS', speed: 'fast', caps: ['tts'], bestFor: ['tts'] },
  'tts-aura-2-en': { id: '@cf/deepgram/aura-2-en', name: 'Aura 2 TTS EN', speed: 'fast', caps: ['tts'], bestFor: ['tts'] },
  'melotts': { id: '@cf/myshell-ai/melotts', name: 'MeloTTS', speed: 'fast', caps: ['tts'], bestFor: ['tts'] },

  // EMBEDDINGS
  'bge-large': { id: '@cf/baai/bge-large-en-v1.5', name: 'BGE Large', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'] },
  'bge-base': { id: '@cf/baai/bge-base-en-v1.5', name: 'BGE Base', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'] },
  'bge-small': { id: '@cf/baai/bge-small-en-v1.5', name: 'BGE Small', speed: 'fastest', caps: ['embeddings'], bestFor: ['embeddings'] },
  'bge-m3': { id: '@cf/baai/bge-m3', name: 'BGE M3', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'] },
  'qwen3-embedding': { id: '@cf/qwen/qwen3-embedding-0.6b', name: 'Qwen3 Embedding', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'] },
  'embeddinggemma': { id: '@cf/google/embeddinggemma-300m', name: 'EmbeddingGemma', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'] },

  // CLASSIFICATION
  'distilbert-sst2': { id: '@cf/huggingface/distilbert-sst-2-int8', name: 'DistilBERT SST-2', speed: 'fastest', caps: ['classification'], bestFor: ['sentiment'] },
  'bge-reranker': { id: '@cf/baai/bge-reranker-base', name: 'BGE Reranker', speed: 'fast', caps: ['classification'], bestFor: ['reranking'] },
  'resnet-50': { id: '@cf/microsoft/resnet-50', name: 'ResNet-50', speed: 'fast', caps: ['classification'], bestFor: ['image_classification'] },

  // TRANSLATION
  'm2m100': { id: '@cf/meta/m2m100-1.2b', name: 'M2M-100', params: '1.2B', speed: 'fast', caps: ['translation'], bestFor: ['translation'] },
  'indictrans2': { id: '@cf/ai4bharat/indictrans2-en-indic-1B', name: 'IndicTrans2', params: '1B', speed: 'fast', caps: ['translation'], bestFor: ['translation'] },
};

// ROUTING TABLE - Maps task types to model chains.
// Workers AI models run first (cheap, low latency). The premium AI Gateway
// model (gpt-5.6-sol) is preferred for quality-critical tasks; when the gateway
// isn't configured the router skips it instantly and falls through to Workers AI.
export const ROUTING_TABLE = {
  quick_qa: {
    label: 'Quick Q&A',
    chains: [
      { model: 'llama-3.1-8b', reason: 'fastest response' },
      { model: 'llama-3.2-3b', reason: 'tiny + fast' },
      { model: 'gpt-oss-20b', reason: 'smart + fast' },
      { model: 'glm-4.7-flash', reason: 'fast + large context' },
      { model: 'gpt-5.6-sol', reason: 'premium last-resort' },
    ],
  },
  code_gen: {
    label: 'Code Generation',
    chains: [
      { model: 'qwen-coder-32b', reason: 'specialized code model' },
      { model: 'kimi-k2.7-code', reason: '1T code model' },
      { model: 'glm-5.2', reason: 'agentic coding' },
      { model: 'qwen3-30b', reason: 'fast code' },
      { model: 'gpt-5.6-sol', reason: 'premium quality generation' },
    ],
  },
  debug: {
    label: 'Debugging & Incident',
    chains: [
      { model: 'gpt-oss-120b', reason: 'deep reasoning' },
      { model: 'deepseek-r1-32b', reason: 'chain-of-thought' },
      { model: 'qwq-32b', reason: 'reasoning model' },
      { model: 'nemotron-120b', reason: 'large reasoning' },
      { model: 'gpt-5.6-sol', reason: 'premium reasoning' },
      { model: 'llama-3.3-70b', reason: 'fast fallback' },
    ],
  },
  review: {
    label: 'Code Review & Security',
    chains: [
      { model: 'gpt-oss-120b', reason: 'thorough analysis' },
      { model: 'nemotron-120b', reason: 'large context' },
      { model: 'deepseek-r1-32b', reason: 'reasoning' },
      { model: 'gpt-5.6-sol', reason: 'premium security review' },
      { model: 'llama-3.3-70b', reason: 'fast review' },
    ],
  },
  explain: {
    label: 'Explanation & Architecture',
    chains: [
      { model: 'llama-3.3-70b', reason: 'clear + fast' },
      { model: 'gpt-oss-20b', reason: 'balanced' },
      { model: 'gemma-4-26b', reason: 'smart + vision' },
      { model: 'llama-4-scout', reason: 'fast + vision' },
    ],
  },
  mentor: {
    label: 'Mentoring & Interview Prep',
    chains: [
      { model: 'llama-3.3-70b', reason: 'conversational' },
      { model: 'gpt-oss-20b', reason: 'balanced' },
      { model: 'gemma-4-26b', reason: 'knowledgeable' },
      { model: 'mistral-small-24b', reason: 'fast + multilingual' },
    ],
  },
  interview: {
    label: 'Interview Mode',
    chains: [
      { model: 'llama-3.3-70b', reason: 'conversational + fast' },
      { model: 'gpt-oss-20b', reason: 'balanced quality' },
      { model: 'gemma-4-26b', reason: 'knowledgeable' },
      { model: 'mistral-small-24b', reason: 'fast + multilingual' },
    ],
  },
  deep_reasoning: {
    label: 'Deep Reasoning',
    chains: [
      { model: 'gpt-5.6-sol', reason: 'premium deep reasoning' },
      { model: 'gpt-oss-120b', reason: '120B reasoning' },
      { model: 'nemotron-120b', reason: '120B agentic' },
      { model: 'deepseek-v4-pro', reason: '1M context reasoning' },
      { model: 'qwq-32b', reason: 'reasoning specialist' },
      { model: 'deepseek-r1-32b', reason: 'chain-of-thought' },
    ],
  },
  scripting: {
    label: 'Shell & CI/CD Scripts',
    chains: [
      { model: 'qwen-coder-32b', reason: 'code specialist' },
      { model: 'glm-5.2', reason: 'agentic coding' },
      { model: 'llama-3.3-70b', reason: 'general capable' },
      { model: 'qwen3-30b', reason: 'fast + tools' },
    ],
  },
  vision: {
    label: 'Image Analysis',
    chains: [
      { model: 'llama-4-scout', reason: 'multimodal flagship' },
      { model: 'gemma-4-26b', reason: 'vision + reasoning' },
      { model: 'qwen3.8-27b', reason: 'vision capable' },
      { model: 'llama-3.2-11b-vision', reason: 'dedicated vision' },
    ],
  },
  image_gen: {
    label: 'Image Generation',
    chains: [
      { model: 'flux-2-dev', reason: 'highest quality' },
      { model: 'flux-2-klein-9b', reason: 'quality + speed' },
      { model: 'flux-1-schnell', reason: 'fastest' },
      { model: 'sdxl', reason: 'classic quality' },
    ],
  },
  transcription: {
    label: 'Speech to Text',
    chains: [
      { model: 'whisper-large-v3', reason: 'best accuracy' },
      { model: 'deepgram-nova-3', reason: 'fast + accurate' },
      { model: 'whisper', reason: 'reliable' },
    ],
  },
  general: {
    label: 'General',
    chains: [
      { model: 'llama-3.3-70b', reason: 'best balance speed+quality' },
      { model: 'gpt-oss-20b', reason: 'smart + fast' },
      { model: 'gemma-4-26b', reason: '26B flagship' },
      { model: 'llama-4-scout', reason: 'MoE fast' },
      { model: 'gpt-5.6-sol', reason: 'premium last-resort' },
    ],
  },
};
