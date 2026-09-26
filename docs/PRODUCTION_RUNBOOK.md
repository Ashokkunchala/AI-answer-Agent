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

## 9. Free-first guardrails

Current Cloudflare documentation lists Workers Free limits for D1, SQLite-backed Durable Objects and Workflows. For example, the current Free plan lists 5 million D1 rows read/day, 100,000 D1 rows written/day, and 3,000 Workflow steps/day. Limits can change, so verify the account's current dashboard before production traffic. citeturn0search4

Do not enable paid/unified AI Gateway billing just to make the architecture work. Add paid providers deliberately and measure the value first.

## 10. Public exposure

Before making the service public:

- Put authentication in front of sensitive endpoints.
- Keep rate limiting enabled.
- Restrict CORS to the desktop/app origin when possible.
- Add Cloudflare WAF/Turnstile where appropriate.
- Rotate provider secrets regularly.
- Monitor Worker logs and error rates.
- Never expose resume/JD/session data through public URLs without authorization.
