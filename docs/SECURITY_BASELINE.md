# Security baseline

## Status

The Worker now rejects unauthenticated protected requests by default, restricts API-key administration to an administrator token, and requires authentication before accepting the voice WebSocket path.

This is a baseline, not a certification or a complete penetration test. Configure platform-level rate limits before public exposure.

## Required secrets

Configure these as Cloudflare Worker secrets, never in source code, `wrangler.toml`, screenshots or commits:

- `ADMIN_API_TOKEN`: a long random secret used only for dashboard and API-key administration.
- `GATEWAY_API_TOKEN` or `GATEWAY_API_KEY`: optional AI Gateway credentials, only if that provider is enabled.

From the Worker package directory:

```powershell
npx wrangler secret put ADMIN_API_TOKEN
```

Paste the secret only into the secure prompt. Do not put it on the command line or in chat.

API clients use a separately generated API key:

```http
Authorization: Bearer dvops_<id>_<secret>
```

The admin token is not an ordinary API key. Regular API keys must not create, list, revoke or delete other keys.

## Public versus protected endpoints

Public by design:
- `GET /`
- `GET /health`
- `GET /v1/models`
- `GET /v1/tasks`
- `GET /dashboard` (HTML shell only; protected actions require the admin token)

Protected:
- AI chat, simple ask, routing preview, transcription and streaming transcription
- Realtime answer endpoints
- Voice WebSocket upgrade
- Usage and key-management operations

Never set `ALLOW_ANONYMOUS=true` in production. The code permits that switch only when `ENVIRONMENT` is not `production`.

## Before production exposure

1. Create a strong administrator token and store it as a Worker secret.
2. Add Cloudflare rate limiting/WAF rules for expensive endpoints, including chat and audio. The stored `rate_limit` field is not an enforced limiter.
3. Set request-size, message-count, prompt-length, output-token and execution-budget limits.
4. Configure an explicit browser-origin allowlist. CORS is not authentication.
5. Verify revocation across active Worker isolates; the current key-validation cache can retain a key for up to 30 seconds.
6. Set spending and quota alerts with the model provider and Cloudflare.
7. Test missing/invalid credentials, regular-key permissions, admin operations, revoked/expired keys, oversized audio and WebSocket upgrades.
8. Keep logs free of API keys, audio, resumes, transcripts and other secrets.
9. Use separate development and production credentials.
10. Rotate any credential ever committed or pasted into a public issue.

## Browser dashboard

The dashboard asks for `ADMIN_API_TOKEN` when a protected action is first used and keeps it in `sessionStorage` for the current tab. Close the tab to clear the session. Use the admin dashboard only on a trusted device; never embed the admin token in a public frontend or mobile app.

## Incident response

If a key may have leaked:
1. Revoke it immediately through the administrator dashboard/API.
2. Rotate leaked provider or admin secrets in Cloudflare.
3. Review provider usage and Cloudflare logs.
4. Check Git history, artifacts and logs for accidental exposure.
5. Reissue least-privilege credentials and verify the old credentials fail.
