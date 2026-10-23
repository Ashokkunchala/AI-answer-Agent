// Cloudflare Workers AI - All models via env.AI.run()
// No external API keys needed. Just enable Workers AI in dashboard.
//
// pricing fields (USD, verified against GET /accounts/:id/ai/models/search):
//   { in, out, cached? }  - per 1M tokens          (partner per-token billing)
//   { per, usd }          - per unit (audio min / 1k chars / step / inference)
//   { pool: true }        - no partner price; covered by the free
//                           10,000-neurons/day pool ($0.011/1k after)
//   { note }              - billed elsewhere (AI Gateway / promo)

export const VERSION = '4.0.0';

export const MODELS = {
  // AI GATEWAY (Premium - optional, requires GATEWAY_ACCOUNT_ID + GATEWAY_API_TOKEN/KEY)
  // Billed via AI Gateway unified billing (promo pricing on gpt-5.6-sol).
  'gpt-5.6-sol': { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', params: 'sol', context: 128000, max_tokens: 16384, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','review','code_gen','debug','general'], provider: 'gateway', pricing: { note: 'AI Gateway billing (promo)' } },

  // GOOGLE VIA WORKERS AI (auto-routed through AI Gateway by slug)
  'gemini-3.1-flash-lite': { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', context: 1000000, max_tokens: 8192, speed: 'fast', caps: ['streaming'], wire: 'gemini', bestFor: ['interview','quick_qa','general','explain'], pricing: { note: 'AI Gateway billing' } },
  'google/gemini-3.1-flash-lite': { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', context: 1000000, max_tokens: 8192, speed: 'fast', caps: ['streaming'], wire: 'gemini', bestFor: ['interview','quick_qa','general','explain'], pricing: { note: 'AI Gateway billing' } },

  // FLAGSHIP TEXT (Best Quality)
  'gpt-oss-120b': { id: '@cf/openai/gpt-oss-120b', name: 'GPT OSS 120B', params: '120B', context: 128000, max_tokens: 16384, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','debug','review','explain'], pricing: { in: 0.35, out: 0.75 } },
  'gpt-oss-20b': { id: '@cf/openai/gpt-oss-20b', name: 'GPT OSS 20B', params: '20B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['quick_qa','general','explain'], pricing: { in: 0.2, out: 0.3 } },
  'nemotron-120b': { id: '@cf/nvidia/nemotron-3-120b-a12b', name: 'Nemotron 3 120B', params: '120B', context: 256000, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['deep_reasoning','debug','review'], pricing: { in: 0.5, out: 1.5 } },
  'kimi-k2.7-code': { id: '@cf/moonshotai/kimi-k2.7-code', name: 'Kimi K2.7 Code', params: '7B', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming','vision'], bestFor: ['code_gen','debug','deep_reasoning'], pricing: { in: 0.95, out: 4, cached: 0.19 } },
  'kimi-k2.6': { id: '@cf/moonshotai/kimi-k2.6', name: 'Kimi K2.6', params: '1T', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming','vision'], bestFor: ['code_gen','explain','general'], pricing: { in: 0.95, out: 4, cached: 0.16 } },
  'llama-3.3-70b': { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', params: '70B', context: 24000, max_tokens: 8192, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','explain','mentor'], pricing: { in: 0.293, out: 2.253 } },
  'llama-4-scout': { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout', params: '17B', context: 131000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming','vision'], bestFor: ['general','quick_qa','explain'], pricing: { in: 0.27, out: 0.85 } },
  'deepseek-r1-32b': { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', name: 'DeepSeek R1 32B', params: '32B', context: 80000, max_tokens: 16384, speed: 'medium', caps: ['reasoning','streaming'], bestFor: ['debug','deep_reasoning','review'], pricing: { in: 0.497, out: 4.881 } },
  'deepseek-v4-flash': { id: '@cf/deepseek-ai/deepseek-v4-flash-0731', name: 'DeepSeek V4 Flash', params: 'MoE', context: 1310720, max_tokens: 32768, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','explain'], pricing: { in: 0.44, out: 1.32, cached: 0.014 } },
  'deepseek-v4-pro': { id: '@cf/deepseek-ai/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro', params: 'MoE', context: 1048576, max_tokens: 32768, speed: 'medium', caps: ['tools','streaming'], bestFor: ['deep_reasoning','debug','review'], pricing: { in: 1.32, out: 3.96, cached: 0.044 } },
  'gemma-4-26b': { id: '@cf/google/gemma-4-26b-a4b-it', name: 'Gemma 4 26B', params: '26B', context: 256000, max_tokens: 32768, speed: 'fast', caps: ['tools','streaming','reasoning','vision'], bestFor: ['general','explain','code_gen'], pricing: { in: 0.1, out: 0.3, cached: 0.05 } },
  'mistral-small-24b': { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 24B', params: '24B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','quick_qa','code_gen'], pricing: { in: 0.351, out: 0.555 } },
  'granite-4.0': { id: '@cf/ibm-granite/granite-4.0-h-micro', name: 'Granite 4.0', params: 'MoE', context: 131000, max_tokens: 16384, speed: 'fast', caps: ['tools','streaming'], bestFor: ['general','explain'], pricing: { in: 0.017, out: 0.112 } },
  'glm-5.2': { id: '@cf/zai-org/glm-5.2', name: 'GLM 5.2', params: 'MoE', context: 262144, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['code_gen','deep_reasoning','debug'], pricing: { in: 1.4, out: 4.4, cached: 0.26 } },
  'glm-4.7-flash': { id: '@cf/zai-org/glm-4.7-flash', name: 'GLM 4.7 Flash', params: 'MoE', context: 131072, max_tokens: 16384, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['quick_qa','general','explain'], pricing: { in: 0.0605, out: 0.4 } },
  'qwen3.8-27b': { id: '@cf/qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', params: '27B', context: 262144, max_tokens: 32768, speed: 'fast', caps: ['tools','reasoning','streaming','vision'], bestFor: ['general','explain','code_gen'], pricing: { in: 0.45, out: 3.2, cached: 0.05 } },
  'sea-lion-27b': { id: '@cf/aisingapore/gemma-sea-lion-v4-27b-it', name: 'SEA-LION 27B', params: '27B', context: 128000, max_tokens: 16384, speed: 'fast', caps: ['streaming'], bestFor: ['general','explain'], pricing: { in: 0.351, out: 0.555 } },

  // GLM 5.3 FLAGSHIP + FLASH (multimodal, 1M-ctx flagship)
  'glm-5.3': { id: '@cf/zai-org/glm-5.3', name: 'GLM 5.3', params: 'MoE', context: 1048576, max_tokens: 32768, speed: 'medium', caps: ['tools','reasoning','streaming'], bestFor: ['code_gen','deep_reasoning','debug'], pricing: { in: 1.4, out: 4.4, cached: 0.26 } },
  'glm-5.3-flash': { id: '@cf/zai-org/glm-5.3-flash', name: 'GLM 5.3 Flash', params: '320B MoE', context: 131072, max_tokens: 16384, speed: 'fast', caps: ['tools','reasoning','streaming','vision'], bestFor: ['interview','quick_qa','general','explain'], pricing: { in: 0.15, out: 0.5, cached: 0.03 } },

  // VOICE AGENT SPECIALISTS (Jarvis stack)
  'phonellm': { id: '@cf/daily-co/phonellm-mini-alpha-2', name: 'PhoneLLM (voice)', params: 'mini', context: 32768, max_tokens: 4096, speed: 'fast', caps: ['streaming'], bestFor: ['interview','quick_qa'], pricing: { pool: true } },
  'smart-turn-v2': { id: '@cf/pipecat-ai/smart-turn-v2', name: 'Smart Turn V2', context: null, max_tokens: 4096, speed: 'fast', caps: ['audio'], bestFor: ['turn_detection'], pricing: { per: 'audio min', usd: 0.000338 } },

  // TOOL-ROUTING DECISION MODELS (Cloudflare Clef family)
  'clef': { id: '@cf/cloudflare/clef', name: 'Clef 27B', params: '27B', context: 131000, max_tokens: 8192, speed: 'medium', caps: ['tools','streaming'], bestFor: ['tool_routing'], pricing: { in: 0.24 } },
  'clef-flash': { id: '@cf/cloudflare/clef-flash', name: 'Clef Flash 9B', params: '9B', context: 131000, max_tokens: 8192, speed: 'fast', caps: ['tools','streaming'], bestFor: ['tool_routing','quick_qa'], pricing: { in: 0.038 } },
  'clef-omni': { id: '@cf/cloudflare/clef-omni', name: 'Clef Omni 30B', params: '30B MoE', context: 131000, max_tokens: 8192, speed: 'medium', caps: ['tools','streaming','vision'], bestFor: ['tool_routing','vision'], pricing: { in: 0.15 } },

  // FREE-POOL TEXT MODELS (no partner price - run on free neuron pool)
  'apertus-8b': { id: '@cf/swiss-ai/apertus-v1.5-8b', name: 'Apertus 1.5 8B', params: '8B', context: 131072, max_tokens: 8192, speed: 'fast', caps: ['streaming'], bestFor: ['general','quick_qa','explain'], pricing: { pool: true } },
  'eurollm-9b': { id: '@cf/utter-project/eurollm-9b-it', name: 'EuroLLM 9B', params: '9B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['streaming'], bestFor: ['general','quick_qa'], pricing: { pool: true } },
  'gemma-2b-lora': { id: '@cf/google/gemma-2b-it-lora', name: 'Gemma 2B (LoRA)', params: '2B', context: 8192, max_tokens: 4096, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa'], pricing: { pool: true } },
  'gemma-7b-lora': { id: '@cf/google/gemma-7b-it-lora', name: 'Gemma 7B (LoRA)', params: '7B', context: 8192, max_tokens: 4096, speed: 'fast', caps: ['streaming'], bestFor: ['quick_qa','general'], pricing: { pool: true } },
  'mistral-7b-lora': { id: '@cf/mistral/mistral-7b-instruct-v0.2-lora', name: 'Mistral 7B v0.2 (LoRA)', params: '7B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['streaming'], bestFor: ['general','quick_qa'], pricing: { pool: true } },
  'llama-2-7b-lora': { id: '@cf/meta-llama/llama-2-7b-chat-hf-lora', name: 'Llama 2 7B (LoRA)', params: '7B', context: 8192, max_tokens: 4096, speed: 'fast', caps: ['streaming'], bestFor: ['quick_qa'], pricing: { pool: true } },

  // CODE-SPECIFIC
  'qwen-coder-32b': { id: '@cf/qwen/qwen2.5-coder-32b-instruct', name: 'Qwen Coder 32B', params: '32B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['streaming'], bestFor: ['code_gen','scripting'], pricing: { in: 0.66, out: 1 } },
  'qwq-32b': { id: '@cf/qwen/qwq-32b', name: 'QwQ 32B', params: '32B', context: 24000, max_tokens: 8192, speed: 'medium', caps: ['reasoning','streaming'], bestFor: ['deep_reasoning','debug'], pricing: { in: 0.66, out: 1 } },
  'qwen3-30b': { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen 3 30B', params: '30B', context: 32768, max_tokens: 8192, speed: 'fast', caps: ['tools','reasoning','streaming'], bestFor: ['code_gen','general','scripting'], pricing: { in: 0.0509, out: 0.335 } },

  // FAST (Low Latency)
  'llama-3.1-8b': { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B', params: '8B', context: 32000, max_tokens: 4096, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa','general'], pricing: { in: 0.152, out: 0.287 } },
  'llama-3.2-3b': { id: '@cf/meta/llama-3.2-3b-instruct', name: 'Llama 3.2 3B', params: '3B', context: 80000, max_tokens: 4096, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa'], pricing: { in: 0.0509, out: 0.335 } },
  'llama-3.2-1b': { id: '@cf/meta/llama-3.2-1b-instruct', name: 'Llama 3.2 1B', params: '1B', context: 60000, max_tokens: 2048, speed: 'fastest', caps: ['streaming'], bestFor: ['quick_qa'], pricing: { in: 0.027, out: 0.201 } },

  // VISION
  'llama-3.2-11b-vision': { id: '@cf/meta/llama-3.2-11b-vision-instruct', name: 'Llama 3.2 11B Vision', params: '11B', context: 128000, max_tokens: 8192, speed: 'fast', caps: ['vision','streaming'], bestFor: ['vision','explain'], pricing: { in: 0.0485, out: 0.676 } },
  'moondream-9b': { id: '@cf/moondream/moondream3.1-9B-A2B', name: 'Moondream 3.1', params: '9B', context: null, max_tokens: 4096, speed: 'fast', caps: ['vision'], bestFor: ['vision'], pricing: { in: 0.3, out: 1 } },
  'llava-7b': { id: '@cf/llava-hf/llava-1.5-7b-hf', name: 'LLaVA 1.5 7B', params: '7B', context: null, max_tokens: 4096, speed: 'fast', caps: ['vision'], bestFor: ['vision'], pricing: { pool: true } },

  // SAFETY
  'llama-guard-3': { id: '@cf/meta/llama-guard-3-8b', name: 'Llama Guard 3', params: '8B', context: 131072, max_tokens: 4096, speed: 'fast', caps: ['streaming'], bestFor: ['safety'], pricing: { in: 0.484, out: 0.03 } },

  // IMAGE GENERATION
  'flux-2-dev': { id: '@cf/black-forest-labs/flux-2-dev', name: 'FLUX 2 Dev', speed: 'medium', caps: ['image'], bestFor: ['image_gen'], pricing: { pool: true } },
  'flux-2-klein-9b': { id: '@cf/black-forest-labs/flux-2-klein-9b', name: 'FLUX 2 Klein 9B', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { pool: true } },
  'flux-2-klein-4b': { id: '@cf/black-forest-labs/flux-2-klein-4b', name: 'FLUX 2 Klein 4B', speed: 'fastest', caps: ['image'], bestFor: ['image_gen'], pricing: { pool: true } },
  'flux-1-schnell': { id: '@cf/black-forest-labs/flux-1-schnell', name: 'FLUX 1 Schnell', speed: 'fastest', caps: ['image'], bestFor: ['image_gen'], pricing: { pool: true } },
  'sdxl': { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', name: 'SDXL Base', speed: 'medium', caps: ['image'], bestFor: ['image_gen'], pricing: { per: 'step', usd: 0 } },
  'sdxl-lightning': { id: '@cf/bytedance/stable-diffusion-xl-lightning', name: 'SDXL Lightning', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { per: 'step', usd: 0 } },
  'sd-inpainting': { id: '@cf/runwayml/stable-diffusion-v1-5-inpainting', name: 'SD 1.5 Inpainting', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { per: 'step', usd: 0 } },
  'dreamshaper': { id: '@cf/lykon/dreamshaper-8-lcm', name: 'Dreamshaper 8', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { pool: true } },
  'lucid-origin': { id: '@cf/leonardo/lucid-origin', name: 'Lucid Origin', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { note: '$0.007 per 512x512 tile / $0.000132 per step' } },
  'phoenix-1.0': { id: '@cf/leonardo/phoenix-1.0', name: 'Phoenix 1.0', speed: 'fast', caps: ['image'], bestFor: ['image_gen'], pricing: { note: '$0.00583 per 512x512 tile / $0.00011 per step' } },

  // AUDIO
  'whisper-large-v3': { id: '@cf/openai/whisper-large-v3-turbo', name: 'Whisper Large V3 Turbo', speed: 'medium', caps: ['audio'], bestFor: ['transcription'], pricing: { per: 'audio min', usd: 0.000513 } },
  'whisper': { id: '@cf/openai/whisper', name: 'Whisper', speed: 'medium', caps: ['audio'], bestFor: ['transcription'], pricing: { pool: true } },
  'whisper-tiny': { id: '@cf/openai/whisper-tiny-en', name: 'Whisper Tiny', speed: 'fastest', caps: ['audio'], bestFor: ['transcription'], pricing: { pool: true } },
  'deepgram-nova-3': { id: '@cf/deepgram/nova-3', name: 'Deepgram Nova 3', speed: 'fast', caps: ['audio'], bestFor: ['transcription'], pricing: { per: 'audio min', usd: 0.0052, note: 'REST $0.0052/min · websocket $0.0092/min' } },
  'deepgram-flux': { id: '@cf/deepgram/flux', name: 'Deepgram Flux', speed: 'fast', caps: ['audio'], bestFor: ['transcription'], pricing: { per: 'audio min', usd: 0.0077, note: 'websocket $0.0077/min (realtime voice agents)' } },
  'tts-aura-1': { id: '@cf/deepgram/aura-1', name: 'Aura TTS', speed: 'fast', caps: ['tts'], bestFor: ['tts'], pricing: { per: '1k chars', usd: 0.015 } },
  'tts-aura-2-en': { id: '@cf/deepgram/aura-2-en', name: 'Aura 2 TTS EN', speed: 'fast', caps: ['tts'], bestFor: ['tts'], pricing: { per: '1k chars', usd: 0.03 } },
  'tts-aura-2-es': { id: '@cf/deepgram/aura-2-es', name: 'Aura 2 TTS ES', speed: 'fast', caps: ['tts'], bestFor: ['tts'], pricing: { per: '1k chars', usd: 0.03 } },
  'melotts': { id: '@cf/myshell-ai/melotts', name: 'MeloTTS', speed: 'fast', caps: ['tts'], bestFor: ['tts'], pricing: { per: 'audio min', usd: 0.000205 } },

  // EMBEDDINGS
  'bge-large': { id: '@cf/baai/bge-large-en-v1.5', name: 'BGE Large', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.204 } },
  'bge-base': { id: '@cf/baai/bge-base-en-v1.5', name: 'BGE Base', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.0666 } },
  'bge-small': { id: '@cf/baai/bge-small-en-v1.5', name: 'BGE Small', speed: 'fastest', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.0202 } },
  'bge-m3': { id: '@cf/baai/bge-m3', name: 'BGE M3', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.0118 } },
  'qwen3-embedding': { id: '@cf/qwen/qwen3-embedding-0.6b', name: 'Qwen3 Embedding', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.0118 } },
  'plamo-embedding': { id: '@cf/pfnet/plamo-embedding-1b', name: 'PLaMo Embedding 1B', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { in: 0.0186 } },
  'embeddinggemma': { id: '@cf/google/embeddinggemma-300m', name: 'EmbeddingGemma', speed: 'fast', caps: ['embeddings'], bestFor: ['embeddings'], pricing: { pool: true } },

  // CLASSIFICATION
  'distilbert-sst2': { id: '@cf/huggingface/distilbert-sst-2-int8', name: 'DistilBERT SST-2', speed: 'fastest', caps: ['classification'], bestFor: ['sentiment'], pricing: { in: 0.0263 } },
  'bge-reranker': { id: '@cf/baai/bge-reranker-base', name: 'BGE Reranker', speed: 'fast', caps: ['classification'], bestFor: ['reranking'], pricing: { in: 0.00311 } },
  'resnet-50': { id: '@cf/microsoft/resnet-50', name: 'ResNet-50', speed: 'fast', caps: ['classification'], bestFor: ['image_classification'], pricing: { per: 'inference', usd: 0.00000251 } },

  // TRANSLATION
  'm2m100': { id: '@cf/meta/m2m100-1.2b', name: 'M2M-100', params: '1.2B', speed: 'fast', caps: ['translation'], bestFor: ['translation'], pricing: { in: 0.342, out: 0.342 } },
  'indictrans2': { id: '@cf/ai4bharat/indictrans2-en-indic-1B', name: 'IndicTrans2', params: '1B', speed: 'fast', caps: ['translation'], bestFor: ['translation'], pricing: { in: 0.342, out: 0.342 } },
};

// ROUTING_TABLE - Maps task types to model chains.
// Each list is the *candidate pool* for the task; the router's budget planner
// (src/platform/budget.js `planChain`) re-orders it at request time:
// free-tier (neuron-pool) models first, then cheapest-first by token price —
// keeping tools-capable models ahead of free-pool ones whenever the caller
// sends tools. Chains still list a strong default first for reference, and
// always include an always-on Workers AI model so a request can never fail
// just because the gateway is unconfigured or a premium model is cooled down.

// Free-pool models (cost $0 on neuron pool, run on free 10k/day allowance)
const FREE_POOL_TEXT = [
  { model: 'eurollm-9b', reason: 'free pool: multilingual 9B' },
  { model: 'apertus-8b', reason: 'free pool: Swiss 8B' },
  { model: 'mistral-7b-lora', reason: 'free pool: Mistral 7B LoRA' },
  { model: 'gemma-7b-lora', reason: 'free pool: Gemma 7B LoRA' },
  { model: 'gemma-2b-lora', reason: 'free pool: Gemma 2B LoRA (fastest)' },
  { model: 'llama-2-7b-lora', reason: 'free pool: Llama 2 7B LoRA' },
];

const FREE_POOL_CODE = [
  { model: 'eurollm-9b', reason: 'free pool: code-capable multilingual' },
  { model: 'apertus-8b', reason: 'free pool: Swiss 8B' },
  { model: 'mistral-7b-lora', reason: 'free pool: Mistral 7B LoRA' },
  { model: 'gemma-7b-lora', reason: 'free pool: Gemma 7B LoRA' },
];

const FREE_POOL_REASONING = [
  { model: 'eurollm-9b', reason: 'free pool: reasoning capable' },
  { model: 'apertus-8b', reason: 'free pool: Swiss 8B' },
];

export const ROUTING_TABLE = {
  quick_qa: {
    label: 'Quick Q&A',
    chains: [
      ...FREE_POOL_TEXT,
      { model: 'llama-3.1-8b', reason: 'fastest response' },
      { model: 'llama-3.2-3b', reason: 'tiny + fast' },
      { model: 'gpt-oss-20b', reason: 'smart + fast' },
      { model: 'glm-4.7-flash', reason: 'fast + large context' },
      { model: 'glm-5.3-flash', reason: 'fast multimodal + cheap' },
      { model: 'gpt-5.6-sol', reason: 'premium last-resort (gateway)' },
    ],
  },
  code_gen: {
    label: 'Code Generation',
    chains: [
      ...FREE_POOL_CODE,
      { model: 'qwen-coder-32b', reason: 'specialized code model' },
      { model: 'kimi-k2.7-code', reason: '1T code model' },
      { model: 'glm-5.2', reason: 'agentic coding' },
      { model: 'glm-5.3', reason: 'flagship agentic coding, 1M ctx' },
      { model: 'qwen3-30b', reason: 'fast code' },
      { model: 'gpt-5.6-sol', reason: 'premium quality generation (gateway)' },
      { model: 'glm-4.7-flash', reason: 'always-on workers-AI safety net' },
    ],
  },
  debug: {
    label: 'Debugging & Incident',
    chains: [
      ...FREE_POOL_REASONING,
      { model: 'gpt-oss-120b', reason: 'deep reasoning' },
      { model: 'deepseek-r1-32b', reason: 'chain-of-thought' },
      { model: 'qwq-32b', reason: 'reasoning model' },
      { model: 'nemotron-120b', reason: 'large reasoning' },
      { model: 'glm-5.3', reason: '1M ctx flagship debugging' },
      { model: 'gpt-5.6-sol', reason: 'premium reasoning (gateway)' },
      { model: 'llama-3.3-70b', reason: 'fast fallback' },
    ],
  },
  review: {
    label: 'Code Review & Security',
    chains: [
      ...FREE_POOL_REASONING,
      { model: 'gpt-oss-120b', reason: 'thorough analysis' },
      { model: 'nemotron-120b', reason: 'large context' },
      { model: 'deepseek-r1-32b', reason: 'reasoning' },
      { model: 'glm-5.3', reason: 'agentic code review' },
      { model: 'gpt-5.6-sol', reason: 'premium security review (gateway)' },
      { model: 'llama-3.3-70b', reason: 'fast review' },
    ],
  },
  explain: {
    label: 'Explanation & Architecture',
    chains: [
      ...FREE_POOL_TEXT,
      { model: 'llama-3.3-70b', reason: 'clear + fast' },
      { model: 'gpt-oss-20b', reason: 'balanced' },
      { model: 'gemma-4-26b', reason: 'smart + vision' },
      { model: 'llama-4-scout', reason: 'fast + vision' },
      { model: 'glm-5.3-flash', reason: 'fast multimodal explainer' },
    ],
  },
  mentor: {
    label: 'Mentoring & Interview Prep',
    chains: [
      ...FREE_POOL_TEXT,
      { model: 'llama-3.3-70b', reason: 'conversational' },
      { model: 'gpt-oss-20b', reason: 'balanced' },
      { model: 'gemma-4-26b', reason: 'knowledgeable' },
      { model: 'mistral-small-24b', reason: 'fast + multilingual' },
    ],
  },
  interview: {
    label: 'Interview Mode',
    chains: [
      { model: 'phonellm', reason: 'voice-agent tuned, free pool' },
      { model: 'eurollm-9b', reason: 'free pool: multilingual' },
      { model: 'gemma-7b-lora', reason: 'free pool: Gemma 7B LoRA' },
      { model: 'gemini-3.1-flash-lite', reason: 'fast + low latency for live voice (gateway)' },
      { model: 'llama-3.3-70b', reason: 'conversational + fast fallback' },
      { model: 'glm-5.3-flash', reason: 'fast multimodal + cheap' },
      { model: 'gpt-oss-20b', reason: 'balanced quality' },
      { model: 'gemma-4-26b', reason: 'knowledgeable' },
      { model: 'mistral-small-24b', reason: 'fast + multilingual' },
    ],
  },
  deep_reasoning: {
    label: 'Deep Reasoning',
    chains: [
      ...FREE_POOL_REASONING,
      { model: 'gpt-5.6-sol', reason: 'premium deep reasoning (gateway)' },
      { model: 'gpt-oss-120b', reason: '120B reasoning' },
      { model: 'nemotron-120b', reason: '120B agentic' },
      { model: 'deepseek-v4-pro', reason: '1M context reasoning' },
      { model: 'glm-5.3', reason: '1M ctx flagship reasoning' },
      { model: 'qwq-32b', reason: 'reasoning specialist' },
      { model: 'deepseek-r1-32b', reason: 'chain-of-thought' },
    ],
  },
  scripting: {
    label: 'Shell & CI/CD Scripts',
    chains: [
      ...FREE_POOL_CODE,
      { model: 'qwen-coder-32b', reason: 'code specialist' },
      { model: 'glm-5.2', reason: 'agentic coding' },
      { model: 'glm-5.3', reason: 'flagship agentic coding' },
      { model: 'llama-3.3-70b', reason: 'general capable' },
      { model: 'qwen3-30b', reason: 'fast + tools' },
    ],
  },
  vision: {
    label: 'Image Analysis',
    chains: [
      { model: 'llava-7b', reason: 'free pool vision safety net' },
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
      { model: 'sdxl-lightning', reason: 'zero-cost per step' },
    ],
  },
  transcription: {
    label: 'Speech to Text',
    chains: [
      { model: 'whisper-tiny', reason: 'free pool: fastest' },
      { model: 'whisper', reason: 'free pool: reliable' },
      { model: 'whisper-large-v3', reason: 'best accuracy' },
      { model: 'deepgram-nova-3', reason: 'fast + accurate' },
    ],
  },
  general: {
    label: 'General',
    chains: [
      ...FREE_POOL_TEXT,
      { model: 'llama-3.3-70b', reason: 'best balance speed+quality' },
      { model: 'gpt-oss-20b', reason: 'smart + fast' },
      { model: 'gemma-4-26b', reason: '26B flagship' },
      { model: 'llama-4-scout', reason: 'MoE fast' },
      { model: 'gpt-5.6-sol', reason: 'premium last-resort (gateway)' },
      { model: 'glm-4.7-flash', reason: 'always-on workers-AI safety net' },
    ],
  },
};
