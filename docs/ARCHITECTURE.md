# Architecture: AI-Answer-Agent

## Big picture

The repository has three main layers. Keep them separate so the API can be tested without launching the desktop UI, and tools can be tested without giving them unrestricted system access.

```text
Desktop Electron client / future Android-first web client
                 |
                 | HTTPS + Authorization header
                 v
        Cloudflare Worker API
                 |
        Authentication + validation
                 |
          Task classifier/router
                 |
        Provider adapter / fallback
                 |
         Model response / stream
                 |
        Client renders answer

DevOps tool layer (separate permission boundary)
                 |
      Read-only tools → plan → approval
                 |
       execute → verify → audit record
```

## Components

### 1. Worker API — `packages/worker/src/`

- `index.js`: HTTP routes, authentication gate, response formatting and realtime answer route.
- `auth.js`: hashed API-key creation/validation, revocation and usage counters.
- `classifier.js`: estimates the type of task from messages.
- `router.js`: selects configured model chains and attempts fallback.
- `config.js`: model catalogue and task routing configuration.
- `providers/`: provider-specific request/response normalization.
- `dashboard.js`: browser dashboard shell for chat and API-key administration.
- `interview/`, `voice/`, `durable/`, `queues/`, `workflows/`: interview, transcript, persistence and background-processing features. Availability depends on the configured Cloudflare bindings.

### 2. Desktop client — `packages/desktop/`

Electron owns the desktop window and native integration. Renderer code presents transcript/answer panels and settings. Voice modules capture/process audio and submit transcription or answer requests. Windows audio capture must be tested on Windows hardware; syntax checks do not validate device behavior.

### 3. Agent and CLI — `packages/agent/`

Developer-facing commands are the future bridge to DevOps tools. They should call narrowly scoped tool adapters, show their plan and results, and avoid shelling out with untrusted generated text.

## Request lifecycle

1. The client sends an HTTPS request with a scoped API key.
2. The Worker rejects missing or invalid credentials before calling protected handlers.
3. The request body is validated and classified.
4. The router selects a configured provider/model chain.
5. The provider adapter normalizes text, stream, error and usage data.
6. The Worker returns a response and records usage best-effort.
7. The client displays the answer or actionable error.

Key administration is separate: only the Cloudflare `ADMIN_API_TOKEN` can create, list, revoke or delete API keys. Do not distribute this token to client apps.

## State and persistence

- KV binding `API_KEYS`: API-key records and usage counters.
- Optional D1: interview/session persistence where configured.
- Optional R2: larger resume/JD/transcript assets.
- Optional Durable Objects, Queues, Workflows and Vectorize: advanced session state, background analysis and retrieval.

These bindings are not interchangeable and should be enabled only when a feature requires them. Follow `docs/CLOUDFLARE_FREE_STACK.md` for the repository's current resource examples. Verify limits and prices in the Cloudflare dashboard before enabling services.

## Safe DevOps-agent execution model

Use this lifecycle for GitHub, Terraform, AWS, Docker and Kubernetes tools:

1. **Understand:** collect the goal and target environment.
2. **Inspect:** run read-only queries with least-privilege credentials.
3. **Plan:** show files/resources to be changed, commands, expected impact and rollback.
4. **Approve:** require explicit approval for writes, deployments, permission changes and destructive actions.
5. **Execute:** run only the approved plan using a constrained tool adapter.
6. **Verify:** re-read state and compare it with the desired outcome.
7. **Report:** provide evidence, logs with secrets redacted, and any follow-up actions.

Do not let a language model directly receive unrestricted production shell, cloud administrator credentials, or an automatic deploy path.

## Configuration boundaries

- Public endpoints: health, model catalogue, task catalogue and the dashboard HTML shell.
- API credentials: normal client API key for protected inference requests.
- Administrator credential: Worker secret used only for key management and trusted administration.
- Provider secrets: Worker secrets, never frontend constants or checked-in files.
- Environment: local development, staging and production should use separate credentials and resource namespaces.

## Known limitations to keep visible

- A health response confirms connectivity, not model availability.
- Model catalogues can contain models unavailable to a particular account or runtime.
- Provider fallback can increase latency and cost.
- KV usage counters are best-effort and should not be treated as a billing ledger.
- The current API-key validation cache may delay revocation visibility by up to 30 seconds in other isolates.
- Production rate limiting and explicit CORS allowlisting must be configured at the platform edge before public exposure.
