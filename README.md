# AI Answer Agent

An AI-powered **interview & meeting assistant** that runs as an invisible Electron overlay on your desktop. It listens to interview questions (via screen/audio capture), transcribes them in real time, and streams a polished AI answer back in seconds — all powered by a Cloudflare Worker backend that routes to 45+ AI models.

> Also known internally as the **DevOps AI Agent Suite**: a monorepo containing a Cloudflare Worker API + Electron desktop client.

---

## What it does

| Capability | Description |
|-----------|-------------|
| 🎙️ **Live interview transcription** | Captures audio (WASAPI loopback / mic) and turns speech into text in real time |
| 🧠 **AI answer generation** | Sends the transcript to the Worker, which classifies the question and streams a tailored answer |
| 📺 **Invisible overlay UI** | Always-on-top, anti-screen-capture window shows transcript + live AI answer |
| 👁️ **Screen OCR** | Detects on-screen questions/text via Tesseract.js |
| 🗣️ **Voice input & meeting mode** | Mic/speech input, participant & speaker detection |
| 🔑 **API keys & usage** | Worker manages keys (`dvops_...`), tracks usage, and exposes a web dashboard |
| 🎨 **Image generation** | FLUX / SDXL via the Worker |
| 🔊 **Audio transcription** | Whisper (batch) + Deepgram (streaming) |

---

## Monorepo layout

```
AI-answer-Agent/
├── packages/
│   ├── worker/          # Cloudflare Worker API
│   │   ├── src/
│   │   │   ├── index.js          # Request routing, CORS, SSE streaming
│   │   │   ├── config.js         # 45+ models + routing table
│   │   │   ├── classifier.js     # Classifies questions (code_gen, debug, ...)
│   │   │   ├── router.js         # Model chain with automatic fallback
│   │   │   ├── system-prompts.js # Task-specific system prompts
│   │   │   ├── auth.js           # API key auth (SHA-256 + KV storage)
│   │   │   ├── dashboard.js      # Web UI for API key & usage management
│   │   │   └── providers/        # Workers AI + AI Gateway providers
│   │   └── wrangler.toml
│   │
│   └── desktop/         # Electron desktop client
│       ├── src/
│       │   ├── main.js           # Electron main process (IPC, AI queries)
│       │   ├── preload.js        # Secure IPC bridge
│       │   ├── ocr-engine.js     # Tesseract.js screen OCR
│       │   ├── voice-service.js  # Audio capture + speech pipeline
│       │   └── providers/        # Deepgram, Whisper, browser STT
│       └── renderer/             # Overlay UI (components, HTML)
│
├── shared/              # Shared ES modules (constants, SSE parser, fetch utils)
├── package.json         # npm workspaces root
├── PLAN.md              # Internal implementation plan / roadmap
└── .gitignore
```

---

## Quick start

### Prerequisites

- **Node.js 18+** and npm
- A **Cloudflare account** for the Worker (wrangler + Workers AI)
- (Desktop) Electron runs on **Windows**

### 1. Install dependencies

```bash
npm install
```

### 2. Run the Worker (Cloudflare)

```bash
npm run dev:worker        # local dev (wrangler dev)
npm run build:worker      # deploy (wrangler deploy)
```

**First deploy:** create a KV namespace for API keys and paste its ID into `packages/worker/wrangler.toml`:

```bash
npx wrangler kv namespace create API_KEYS
```

### 3. Run the Desktop app (Electron)

```bash
npm run dev:desktop       # launch the overlay app
npm run build:desktop     # build a Windows installer (.exe)
```

---

## API overview

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/chat/completions` | `POST` | OpenAI-compatible chat, SSE streaming |
| `/v1/audio/transcriptions` | `POST` | Whisper batch transcription |
| `/v1/images/generations` | `POST` | FLUX / SDXL image generation |
| `/voice-socket` | `WS` | Real-time streaming STT |
| `/dashboard` | `GET` | API key + usage management UI |
| `/health` | `GET` | Health check |

Authentication uses bearer API keys in the format `dvops_<id>_<secret>` (see `src/auth.js`).

---

## Environment variables

Set secrets via `npx wrangler secret put <NAME>`:

| Variable | Description |
|----------|-------------|
| `GATEWAY_API_TOKEN` | Cloudflare API token for AI Gateway (optional) |
| `GATEWAY_API_KEY` | Legacy AI Gateway key (optional) |

Set VARS in `wrangler.toml`:

| Variable | Description |
|----------|-------------|
| `ENVIRONMENT` | `production` or `development` |

Optional AI Gateway fallback (premium model) — see comments in `wrangler.toml`.

---

## How an answer gets generated

```
Interview audio ──▶ VAD detects speech ──▶ STT (Deepgram/Whisper)
        │
        ▼
Cloudflare Worker: classify question ──▶ pick model chain ──▶ stream tokens
        │
        ▼
Desktop overlay: live transcript + streaming AI answer
```

---

## Useful scripts

```bash
npm run dev:worker       # wrangler dev
npm run dev:desktop      # electron .
npm run build:worker     # wrangler deploy
npm run build:desktop    # electron-builder -> .exe
```

---

## License

MIT