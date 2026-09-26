# AI Answer Agent

An AI-powered **interview & meeting assistant** that runs as an Electron desktop overlay. It captures interview audio, performs real-time transcription, and streams context-aware AI answers through a Cloudflare Worker backend.

## Architecture

```text
Windows audio / microphone
        ↓
Desktop DSP + VAD + streaming STT
        ↓
POST /api/answer
        ↓
Cloudflare Worker → session context → AI Router
        ↓
Workers AI / optional AI Gateway fallback
        ↓
SSE streaming answer
        ↓
D1 interview turn persistence

Interview complete
        ↓
POST /api/session/:id/finalize
        ↓
Cloudflare Workflow
        ↓
AI interview evaluation
        ↓
D1 interview report
```

## Capabilities

| Capability | Status |
|---|---|
| Live interview transcription | Implemented |
| Windows audio/WASAPI pipeline | Implemented in desktop client |
| VAD and turn management | Implemented |
| Streaming AI answers | Implemented |
| Task-aware model routing | Implemented |
| Model fallback | Implemented |
| Persistent interview sessions | Implemented when D1 is bound |
| Persistent conversation context | Implemented when D1 is bound |
| Post-interview scoring/report | Implemented when D1 + Workflow are bound |
| Resume/JD asset storage helpers | Implemented when R2 is bound |
| API keys + usage | Implemented |
| Cloudflare KV response cache | Implemented when AI_CACHE is bound |
| Durable Object session foundation | Implemented |
| Queue foundation | Implemented |

## Repository layout

```text
AI-answer-Agent/
├── packages/
│   ├── worker/
│   │   ├── src/
│   │   │   ├── index.js
│   │   │   ├── entrypoint.js
│   │   │   ├── router.js
│   │   │   ├── classifier.js
│   │   │   ├── system-prompts.js
│   │   │   ├── auth.js
│   │   │   ├── platform/cloudflare.js
│   │   │   ├── durable/interview-session.js
│   │   │   ├── queues/interview.js
│   │   │   └── workflows/interview-analysis.js
│   │   ├── migrations/
│   │   └── wrangler.toml
│   └── desktop/
│       ├── src/
│       │   ├── voice-service.js
│       │   └── providers/
│       └── renderer/
├── shared/
├── docs/
└── scripts/cloudflare/
```

## Interview API

### Create a session

`POST /api/session`

```json
{
  "candidateName": "Candidate",
  "roleTitle": "DevOps Engineer",
  "company": "Example"
}
```

### Ask during an interview

`POST /api/answer`

```json
{
  "sessionId": "SESSION_ID",
  "turnId": "TURN_ID",
  "question": "How does Kubernetes rolling deployment work?",
  "stream": true,
  "roleTitle": "DevOps Engineer",
  "jobDesc": "...",
  "resume": "..."
}
```

The Worker automatically loads recent persisted turns for the session and uses them as additional context.

### Read context

`GET /api/session/:id/context?limit=50`

### Finalize the interview

`POST /api/session/:id/finalize`

This starts the post-interview Workflow when the Workflow binding is configured.

### Read the report

`GET /api/session/:id/report`

The report contains structured scores and coaching fields such as technical correctness, communication, confidence, strengths, weaknesses and missed points.

## Cloudflare free-first setup

See `docs/CLOUDFLARE_FREE_STACK.md` and `packages/worker/wrangler.free.example.toml`.

Provisioning helper:

```bash
cd packages/worker
npm run provision:free
```

Then apply D1 migrations and deploy:

```bash
npx wrangler d1 migrations apply ai-answer-agent --remote
npx wrangler deploy
```

Do not commit Cloudflare API tokens or provider secrets.

## Development

```bash
npm install
npm run dev:worker
npm run dev:desktop
```

Node.js 18+ is required.

## Validation

A GitHub Actions workflow runs JavaScript syntax validation and a Cloudflare Worker dry-run build for pushes and pull requests.

## License

MIT
