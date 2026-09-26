# Cloudflare Free-First Stack

AI-Answer-Agent uses Cloudflare as the low-cost control plane while keeping the existing desktop voice pipeline responsible for raw microphone DSP/VAD/STT.

## Hot path

```text
Microphone -> Desktop DSP/VAD -> STT -> Worker -> AI Router -> AI Gateway/Workers AI -> streaming answer
```

Do not put raw continuous microphone audio into the Worker hot path.

## Resource roles

| Resource | Role | Hot path? | Notes |
|---|---|---:|---|
| Workers | API + AI orchestration | Yes | Keep CPU work small and stream responses |
| Durable Objects | Live interview session state | Yes | One logical session/object |
| AI Gateway | Provider routing/analytics/cache | Yes | Keep Unified Billing disabled for $0 target |
| KV | Short TTL response/config cache | Yes, optional | `AI_CACHE`; never source of truth |
| D1 | Interview sessions and turns | No for reads; async writes | Structured persistent state |
| R2 | Resume/JD/project/transcript/report files | No | Document/object storage |
| Workers AI | Utility/fallback AI | Yes for lightweight tasks | Conserve the daily free neuron allocation |
| Queues | Background work | No | Never block answer latency |
| Workflows | Multi-step post-interview processing | No | Resume/report analysis |
| Workers Logs | Debugging/latency visibility | No | Keep production observability enabled |
| Turnstile/WAF | Edge security | No | Add when exposing public endpoints |
| Browser Run | Agent web research | No | Use only when an agent task needs a browser |

## What is implemented now

- Optional KV response caching with a 60-second TTL for non-streaming, non-session requests.
- Interview turns persist asynchronously to D1 when `INTERVIEW_DB` is configured.
- R2 helpers for interview assets and document metadata.
- Cloudflare capability detection helper.
- SQLite-backed Durable Object implementation for live interview state.
- Queue consumer skeleton for post-interview jobs.
- Workflow skeleton for post-interview analysis.
- D1 migration for interview sessions, turns and asset metadata.
- Free-tier resource provisioning helper and Wrangler template.

## Bindings

The existing `API_KEYS` and `AI` bindings remain untouched. Add these bindings only after creating the resources:

```text
AI_CACHE            KV
INTERVIEW_DB        D1
AI_ASSETS           R2
INTERVIEW_SESSIONS  Durable Object
INTERVIEW_QUEUE     Queue
INTERVIEW_WORKFLOW  Workflow
```

See `packages/worker/wrangler.free.example.toml`.

## Cost guardrails

- Keep the Free-first architecture as the default.
- Do not enable AI Gateway Unified Billing for this target.
- Use Workers AI for lightweight classification/routing/fallback tasks.
- Use external paid models only through explicit provider secrets and routing rules.
- Keep background work off the synchronous interview response path.
- Do not store secrets in Wrangler TOML or source code.

## Provisioning

From the repository root:

```bash
bash scripts/cloudflare/provision-free-stack.sh
```

Then populate the returned IDs in the Wrangler template, apply the D1 migration, and deploy.

The Durable Object and Workflow bindings remain deliberately disabled in the template until their classes are exported from the Worker entrypoint. This prevents an infrastructure configuration change from breaking the existing voice service.
