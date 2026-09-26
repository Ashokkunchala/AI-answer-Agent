# Cloudflare Worker Architecture

The Worker now has one production entrypoint: `src/entrypoint.js`.

## Runtime paths

### Realtime voice

```text
WebSocket /voice-socket
  -> Worker WebSocketPair
  -> interview voice handler
  -> STT
  -> optional Vectorize retrieval
  -> AI router
  -> Answer Shield / quality signals
  -> response
```

The Worker owns the connection boundary; live session metadata can be coordinated through the SQLite-backed `InterviewSession` Durable Object when the binding is enabled.

### Normal API

```text
HTTP
  -> security/rate limit
  -> interview API
  -> existing AI router
  -> D1/KV/R2 as available
```

The legacy request implementation remains an internal application module imported by the single entrypoint. It is not a second Worker entrypoint.

## Cloudflare resource roles

- **Workers:** edge API and routing.
- **Durable Objects (SQLite):** per-interview realtime state and coordination.
- **D1:** durable relational interview records, turns, scores and reports.
- **KV:** low-latency cache/configuration; never the source of truth.
- **R2:** resume, JD, transcript and report objects.
- **Queues:** deferred persistence/indexing/background work.
- **Workflows:** durable post-interview analysis and retries.
- **Workers AI:** lightweight inference and embeddings. The current retrieval implementation uses `@cf/baai/bge-base-en-v1.5` (768 dimensions).
- **Vectorize:** semantic retrieval over resume/JD/project context when the binding is enabled.

## Free-first rules

- Keep Vectorize optional until its account binding exists.
- Keep D1/KV/R2/Queue/Workflow account-specific IDs out of source control until provisioned.
- Do not put API tokens in `wrangler.toml`.
- Do not block the live answer path on post-interview analysis.
- Use `ctx.waitUntil()` for non-critical indexing/state updates.
- Cache only safe, non-session responses.
- Prefer smaller/fast Workers AI models for routing/utility tasks; complex answers can use the configured AI router.

## Vector retrieval

At interview start, resume and job-description context is asynchronously indexed. For each stable question, the Worker embeds the question and queries Vectorize for the most relevant context. Retrieved text is explicitly labeled as reference data in the model prompt and is never treated as an instruction.

If Vectorize is unavailable, the interview continues using the existing resume/JD context and interview memory.
