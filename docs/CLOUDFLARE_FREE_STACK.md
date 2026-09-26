# Cloudflare Free-First Stack

AI-Answer-Agent uses Cloudflare as the low-cost control plane while keeping the desktop voice pipeline responsible for microphone/audio capture, DSP/VAD and STT.

## End-to-end interview path

```text
Microphone / WASAPI
   -> Desktop DSP + VAD
   -> Streaming STT
   -> /api/answer
   -> persisted session context
   -> AI Router
   -> Workers AI / optional Gateway
   -> SSE answer stream
   -> D1 turn persistence

Interview ends
   -> POST /api/session/:id/finalize
   -> Workflow
   -> AI evaluation
   -> D1 interview_reports
   -> GET /api/session/:id/report
```

Raw continuous microphone audio stays out of the Worker hot path.

## Resource roles

| Resource | Role | Interview path |
|---|---|---|
| Workers | API + orchestration | Live |
| Durable Objects | Per-session coordination/state foundation | Live/optional |
| KV | Short TTL response cache | Optional; never source of truth |
| D1 | Sessions, turns and reports | Persistent |
| R2 | Resume/JD/transcript/report files | Asset storage |
| Workers AI | Lightweight/fallback AI | Live |
| Queue | Background jobs | Async |
| Workflow | Post-interview scoring/report | Async |
| Workers Logs | Debugging/latency visibility | Operational |

## Implemented

- KV response caching for safe non-streaming/non-session requests.
- Persisted interview context is automatically loaded into subsequent `/api/answer` calls.
- Streaming interview answers are persisted to D1 after the final token without delaying first-token latency.
- `POST /api/session` creates a durable interview session.
- `GET /api/session/:id/context` returns persisted turns.
- `POST /api/session/:id/finalize` starts the post-interview Workflow when configured.
- `GET /api/session/:id/report` returns the evaluation report.
- Workflow evaluates technical correctness, communication, confidence and missed points and persists structured JSON.
- R2 helpers for interview assets.
- Durable Object implementation for live session state.
- Queue consumer foundation for non-latency-sensitive jobs.
- D1 migrations for interview sessions, turns, assets and reports.

## Bindings

```text
AI                  Workers AI
API_KEYS            existing API-key KV
AI_CACHE            optional cache KV
INTERVIEW_DB        D1
AI_ASSETS           R2
INTERVIEW_SESSIONS  Durable Object
INTERVIEW_QUEUE     Queue
INTERVIEW_WORKFLOW  Workflow
```

Use `packages/worker/wrangler.free.example.toml` as the account-specific template. It intentionally contains placeholders for resource IDs because those IDs belong to the user's Cloudflare account.

## Provisioning

```bash
cd packages/worker
npm run provision:free
```

Then copy the returned IDs into your deployment configuration, apply migrations, and deploy:

```bash
npx wrangler d1 migrations apply ai-answer-agent --remote
npx wrangler deploy
```

## Cost guardrails

- Keep the Free-first architecture as the default.
- Do not enable AI Gateway Unified Billing when targeting a $0 Cloudflare architecture.
- Keep raw audio processing on the desktop.
- Use Workers AI for lightweight routing/classification where appropriate.
- Keep background analysis in Workflow/Queue rather than the live answer path.
- Never commit API tokens or other secrets.
