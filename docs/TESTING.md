# Testing and troubleshooting

## Fast validation

From the repository root:

```powershell
npm ci
npm run test:security
npm run check:worker
```

Start the Worker in a separate terminal first:

```powershell
npm run dev:worker
```

The security tests use a mocked KV binding. They cover public health, unauthenticated API denial, production anonymous-mode denial, API-key creation protection, regular-key privilege separation, and WebSocket authentication.

## Common failures

### `ECONNREFUSED 127.0.0.1:8787`
No process is listening at the configured address. Run `npm run dev:worker`, wait for Wrangler to print its URL, then run `npm run check:worker` in another terminal. If Wrangler selected a different port, set `WORKER_URL` to that URL.

### HTTP 401
The endpoint requires credentials. Send an API key in the Authorization header.

### HTTP 403
The supplied credential is invalid/revoked, or the operation requires the administrator token. Use the admin token only for key administration.

### Worker responds, but model calls fail
Connectivity is only the first check. Verify Workers AI binding, model availability, optional AI Gateway secrets, quotas and provider errors. A successful health check does not prove inference works.

### Voice UI opens, but no transcript appears
Test audio capture and transcription separately. Confirm the Windows audio source, permissions, supported format and provider configuration. Capture the sanitized failing stage; never attach tokens or private interview audio to an issue.

## Release checklist

- [ ] Security tests pass locally and in GitHub Actions.
- [ ] Worker dry-run build succeeds.
- [ ] Public endpoints expose no secrets.
- [ ] Protected endpoints reject missing/invalid credentials.
- [ ] Regular API keys cannot manage other keys.
- [ ] Admin token is stored only as a platform secret.
- [ ] Platform rate limiting and provider usage alerts are configured.
- [ ] Chat, streaming and transcription tested independently.
- [ ] Desktop tests run on supported Windows hardware.
- [ ] Deployment reviewed and manually approved; CI does not deploy automatically.
