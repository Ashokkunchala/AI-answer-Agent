# Production Runbook

## 1. Install

```bash
npm install
```

## 2. Validate the project

```bash
npm run test:interview
npm run preflight:cloudflare
```

The preflight intentionally performs a Wrangler dry-run. It does not deploy.

## 3. Provision Cloudflare resources

Use the existing free-first helper:

```bash
npm run provision:free --workspace packages/worker
```

Create/reuse these resources:

- KV: `AI_CACHE`
- D1: `INTERVIEW_DB`
- R2: `AI_ASSETS`
- Durable Object: `INTERVIEW_SESSIONS`
- Queue: `INTERVIEW_QUEUE`
- Workflow: `INTERVIEW_WORKFLOW`

Keep account-specific IDs in local/CI configuration, never in source unless they are intended public resource identifiers.

## 4. Apply D1 migrations

```bash
cd packages/worker
npx wrangler d1 migrations apply ai-answer-agent --remote
```

## 5. Secrets

Set provider credentials through Wrangler secrets when required:

```bash
npx wrangler secret put GATEWAY_API_TOKEN
npx wrangler secret put GATEWAY_API_KEY
```

Do not put credentials in `wrangler.toml`, source files, GitHub issues, or logs.

## 6. Deploy

```bash
npx wrangler deploy
```

## 7. Smoke tests

```bash
curl -fsS https://YOUR_WORKER/health
curl -fsS https://YOUR_WORKER/v1/models
curl -fsS https://YOUR_WORKER/v1/tasks
```

Then test:

1. Create a session.
2. Send one text interview question.
3. Send one voice turn.
4. Confirm the answer contains mode/quality/follow-up metadata.
5. Finalize the session.
6. Confirm the Workflow produces a report.
7. Confirm D1 contains turns and report data.
8. Confirm R2 asset operations if uploads are enabled.

## 8. Performance checks

Record:

- STT latency
- first-answer-token latency
- total answer latency
- model selected
- fallback count
- cache hit rate
- WebSocket reconnects
- answer length
- guard flags

Keep the live answer path free of D1/R2/Workflow work unless absolutely necessary. Cloudflare's storage guidance recommends Durable Objects for real-time coordination, D1 for relational data, R2 for object data, KV for high-read key/value data, and Queues for background work. citeturn0search0turn0search1

## 9. Pay-as-you-go configuration (current decision)

This deployment is **not** free-first: it runs pay-as-you-go on the Workers Paid plan with **no application-level cost or bill limits**.

### 9.1 Cloudflare usage model

Workers Paid's current usage model is named **Standard**. The legacy names were `bundled` (old Standard) and `unbound` (old pay-per-request); there is no `pay-per-request` value today and the API rejects it:

```
Invalid usage model. Please provide a valid usage model: 'standard'.
```

Account `808e003dfdde0e801aac9c88aa7c9b84` is already correct:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/account-settings" \
  -H "Authorization: Bearer $TOKEN"
# { "default_usage_model": "standard", "green_compute": false }

curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/devops-ai-agent/settings" \
  -H "Authorization: Bearer $TOKEN"
# { "usage_model": "standard", ... }
```

To change it: dashboard (Workers & Pages > account > Usage Model > Change) or `PUT /accounts/{id}/workers/account-settings` with a token holding **Account Settings Write**. Wrangler OAuth tokens do not carry that permission, and `PATCH` on script settings is not available to them.

### 9.2 Application-level limits (all disabled)

| Setting | Value | Meaning |
| --- | --- | --- |
| `BUDGET_MONTHLY_USD` | `0` | No router spend cap; `saver` and `blocked` modes are unreachable. |
| `MAX_OUTPUT_TOKENS` | `0` | No per-request output cap; each call may use the model's own `max_tokens`. |
| `NEURON_FREE_DAILY` | `10000` | Daily free Workers AI allowance, still spent first. |
| Rate limiting | disabled | Unlimited requests for keys and anonymous use. |

Cloudflare account billing and payment methods still apply independently of this worker.

### 9.3 AI Gateway partner models

Models reached through AI Gateway (for example `google/gemini-3.1-flash-lite`, `gpt-5.6-sol`) fail with:

```
2021: Insufficient AI Gateway credits
```

They need prepaid credits or unified billing on the Gateway (`AI_GATEWAY_ID = "default"`). Enable it in the dashboard (AI Gateway > Settings > Unified billing) or with an API token holding **Account AI Gateway Write**. Direct Workers AI models (`llama-3.3-70b`, `llama-3.1-8b`, the free pool) bill per neuron on the account's Standard usage model and work without Gateway credits.

Until credits are loaded, partner models still work as a request: the router catches the gateway billing error and degrades to the cheapest capable direct Workers AI model, reporting `routing.reason = "direct Workers AI fallback (AI Gateway unified billing unavailable)"`.

### 9.4 Verifying a deploy

```bash
npm run preflight:cloudflare
npx wrangler deploy --cwd packages/worker
curl https://devops-ai-agent.ashokkunchla.workers.dev/health
curl https://devops-ai-agent.ashokkunchla.workers.dev/v1/status
```

`/health` and `/v1/status` must report `unlimited_budget: true`, `max_output_tokens: 0` and the full model count. Wrangler deploys do not delete secrets, but confirm `DASHBOARD_ADMIN_KEY` is still present afterwards:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/devops-ai-agent/secrets" \
  -H "Authorization: Bearer $TOKEN"
```

## 10. Public exposure

Before making the service public:

- Put authentication in front of sensitive endpoints.
- Keep rate limiting enabled.
- Restrict CORS to approved application origins.
- Add Cloudflare WAF/Turnstile where appropriate.
- Rotate provider secrets regularly.
- Monitor Worker logs and error rates.
- Never expose resume/JD/session data through public URLs without authorization.
