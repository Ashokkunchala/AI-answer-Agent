# AI-Answer-Agent

A practical AI assistant foundation with a Cloudflare Worker API, task-aware model routing, and DevOps-agent tooling. The long-term goal is a JARVIS-like assistant that can explain, plan, use tools, verify results and safely execute approved tasks.

**Reality check:** this repository is a work in progress, not a finished autonomous assistant. The project should be advanced in small testable stages. This branch hardens request authentication and documents the path from setup to safe DevOps automation. No cloud deployment is performed by these changes.

## Start from scratch

**Read these in order:**

1. [Start here](docs/START_HERE.md) — beginner-friendly setup and stage-by-stage plan.
2. [Architecture](docs/ARCHITECTURE.md) — components and request flow.
3. [Security baseline](docs/SECURITY_BASELINE.md) — secrets, authentication and production checklist.
4. [Testing and troubleshooting](docs/TESTING.md) — test commands and common errors.
5. [Cloudflare free-first setup](docs/CLOUDFLARE_FREE_STACK.md) — optional resources, quotas and deployment notes.

## What exists today

| Component | Purpose | Notes |
|---|---|---|
| Cloudflare Worker | HTTP API, chat, transcription and realtime answer endpoints | Cloudflare bindings/provider setup may be required |
| Model router | Classifies tasks and chooses configured models/fallbacks | Availability and cost depend on provider/account |
| Voice pipeline | Transcription, realtime answers and turn management | Each stage must be tested independently |
| Agent package/CLI | Developer-facing agent commands | Use read-only operations first |
| Security regression tests | Verify key authentication and authorization boundaries | Run locally and in CI |

## Local development

Requirements: Git, npm, and Node.js 20 LTS recommended (the project declares Node.js 18+).

```powershell
git clone https://github.com/Ashokkunchala/AI-answer-Agent.git
cd AI-answer-Agent
git switch audit/security-realtime-fixes
npm ci
npm run dev:worker
```

Keep the Worker terminal open. In a second terminal:

```powershell
npm run check:worker
npm run test:security
```

The commands above start local development; they do not deploy to Cloudflare. Some provider and persistence features require local bindings or account configuration.

## Useful commands

| Command | What it does |
|---|---|
| `npm ci` | Install locked dependencies |
| `npm run dev:worker` | Run the Worker locally |
| `npm run check:worker` | Test local Worker connectivity |
| `npm run test:security` | Test authentication and authorization |
| `npm run test:interview` | Run interview-pipeline tests |
| `npm run test:agent` | Run agent package tests |
| `npm run preflight:cloudflare` | Check Cloudflare setup prerequisites |

## Security model

- Health, model catalogue and task catalogue are public.
- Protected AI endpoints require an API key.
- API-key creation, listing, revocation and deletion require the separate Cloudflare secret `ADMIN_API_TOKEN`.
- WebSocket voice sessions require authentication.
- Anonymous requests are denied by default; the development opt-in is disabled in production.
- Before public deployment, configure Cloudflare rate limiting, request/token budgets, provider usage alerts and an explicit CORS allowlist.

Follow [Security baseline](docs/SECURITY_BASELINE.md) before deployment. Do not commit credentials or embed the administrator token in a public web/mobile app.

## Roadmap — in order

1. **Secure and test the API** — authentication, key permissions, usage controls and CI.
2. **Verify inference** — model availability, streaming, fallback, timeout and error reporting.
3. **Stabilize voice** — capture, transcription, VAD and answer latency on Windows.
4. **Build Android-first access** — a mobile-friendly frontend using a normal scoped API key, never an admin secret.
5. **Add DevOps tools read-only** — GitHub, Terraform, AWS, Docker and Kubernetes inspection.
6. **Add controlled execution** — plans, previews, approvals, audit logs and verification. Destructive or production actions always require explicit approval.

Each stage should have a clear setup guide, test command, known limitations and a rollback path. Avoid adding features that cannot be tested or explained.

## Troubleshooting: `ECONNREFUSED 127.0.0.1:8787`

This means no local Worker is listening at that address.

1. Start `npm run dev:worker` in the repository root.
2. Wait for Wrangler to print its local URL.
3. Run `npm run check:worker` in a second terminal.
4. If Wrangler chose another port, set `WORKER_URL` to the actual URL.

A successful health check confirms connectivity only; it does not prove that AI providers or inference work.

## API examples

Protected requests use:

```http
Authorization: Bearer dvops_<id>_<secret>
```

Example chat endpoint: `POST /v1/chat/completions`. Example simple question endpoint: `POST /ask` with JSON body `{"question":"Explain Kubernetes readiness probes" }`.

For API-key management, use the administrator token as described in the security guide. Never share or paste tokens into tickets, logs or public chats.

## Development and release policy

- Work on `audit/security-realtime-fixes`; do not merge to `main` without review.
- CI checks JavaScript syntax, runs security regression tests and performs a Worker dry-run build.
- CI does not deploy automatically.
- Confirm actual provider quotas and pricing; "free-first" does not mean unlimited.
- Do not claim a feature is production-ready until it has a reproducible test and its limitations are documented.

## License

MIT
