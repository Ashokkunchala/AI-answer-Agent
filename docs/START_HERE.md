# Start here: AI-Answer-Agent

This repository combines an AI API, model router, Windows Electron voice/interview client, and DevOps-agent tooling. It is not a fully autonomous JARVIS yet. Start with one working path and expand only after each stage is tested.

## Goal

Build a useful personal assistant that answers questions, routes tasks to supported AI providers, supports voice/interview workflows, and progressively adds GitHub, Terraform, AWS, Docker and Kubernetes tools. Start read-only; require approval before changing infrastructure.

## Read in this order

1. [README](../README.md) — project overview and commands.
2. [Architecture](ARCHITECTURE.md) — how components connect.
3. [Security baseline](SECURITY_BASELINE.md) — secrets and access controls.
4. [Testing and troubleshooting](TESTING.md) — verification and common failures.
5. [Cloudflare free-first setup](CLOUDFLARE_FREE_STACK.md) — optional cloud resources and limits.

## A. Local development (recommended first)

Requirements: Git, npm and Node.js 20 LTS recommended (18+ declared). Windows is needed to test Windows-specific audio capture.

```powershell
git clone https://github.com/Ashokkunchala/AI-answer-Agent.git
cd AI-answer-Agent
git switch audit/security-realtime-fixes
npm ci
npm run dev:worker
```

Leave the Worker terminal running. In a second terminal:

```powershell
npm run check:worker
npm run test:security
```

Do not deploy from this quick-start. Some features require Cloudflare bindings or provider configuration.

## B. Desktop application

After the Worker starts, use another terminal:

```powershell
npm run dev:desktop
```

Test the existing Electron UI and voice flow. A UI opening successfully does not prove audio capture, transcription, or inference works.

## C. Cloud deployment

Deploy only after local tests pass. Review [Security baseline](SECURITY_BASELINE.md), configure secrets in Cloudflare, check provider quotas/billing, validate the deployed endpoint, and only then connect clients. Never expose a production Worker with anonymous AI access.

## Useful commands

| Command | Purpose |
|---|---|
| `npm ci` | Install lockfile-pinned dependencies |
| `npm run dev:worker` | Start local Cloudflare Worker |
| `npm run check:worker` | Check local Worker connectivity |
| `npm run test:security` | Run authentication regression tests |
| `npm run test:interview` | Run interview-pipeline tests |
| `npm run test:agent` | Run agent package tests |
| `npm run dev:desktop` | Start Electron client |
| `npm run preflight:cloudflare` | Check Cloudflare setup prerequisites |

## Definition of done

- **Stage 1 — Secure API:** unauthenticated AI calls fail; only administrators manage keys; security tests pass.
- **Stage 2 — Reliable answers:** test provider availability, routing fallback, streaming and errors.
- **Stage 3 — Desktop voice:** verify capture, transcription, question detection and latency on supported Windows hardware.
- **Stage 4 — Mobile access:** add a mobile-first web/PWA client. Never embed a permanent admin token in a public frontend or mobile app.
- **Stage 5 — DevOps tools:** begin read-only; show planned commands and impact before writes.
- **Stage 6 — Controlled execution:** require explicit approval for deployments, deletes, IAM changes and production changes.

## Important

- Work on `audit/security-realtime-fixes`; do not merge to `main` without review.
- This change set is source-only. It does not deploy a Worker or create Cloudflare resources.
- Free-first does not mean unlimited; provider quotas, CPU limits, storage limits and rate limits still apply.
