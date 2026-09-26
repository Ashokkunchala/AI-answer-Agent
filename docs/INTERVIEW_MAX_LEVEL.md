# AI-Answer-Agent — Max-Level Interview Architecture

## Product goal

A low-latency interview copilot that helps the user understand a live question, produce a concise grounded answer, anticipate follow-ups, and learn from the completed interview.

## Real-time path

```text
Desktop microphone
  -> local DSP / echo cancellation / VAD
  -> streaming STT
  -> stable-transcript detector
  -> question classifier
  -> resume + JD + session context
  -> AI router
  -> answer guardrails
  -> streaming answer UI
```

The Worker should not receive raw continuous microphone audio when the desktop client can perform capture/DSP locally. This reduces bandwidth, latency and unnecessary inference work.

## Interview modes

- General interview
- Technical
- Behavioral / STAR
- Coding
- System design
- DevOps / Cloud
- HR / communication

## Grounding

The assistant should distinguish three kinds of statements:

1. **Known** — directly supported by the supplied resume/session context.
2. **Proposed** — a recommended approach the candidate could take.
3. **Unknown** — insufficient evidence; ask for clarification or use cautious language.

Never invent personal experience, employers, metrics, certifications or production incidents.

## Answer quality

Every non-streaming interview answer can receive deterministic local signals for:

- relevance
- clarity
- completeness
- grounding
- excessive length
- unsupported first-person experience claims

These are review signals, not claims about truth. A stronger production implementation should combine them with an explicit model-based evaluator during post-interview analysis.

## Follow-ups

After an answer, a background task can generate likely interviewer follow-ups. Follow-ups should never block the first answer token.

## Storage

- D1: structured sessions, turns, scores and reports
- R2: resumes, job descriptions, transcripts and reports/assets
- KV: short-lived cache only
- Durable Objects: live per-interview coordination/state
- Queues: background fan-out
- Workflows: multi-step post-interview analysis

Cloudflare documents Durable Objects as a fit for stateful real-time applications and SQLite-backed objects on the Free plan; Workflows provide durable multi-step execution and retries. citeturn0search4turn0search2

## Performance rules

- Stream the answer.
- Do not synchronously persist analytics before first token.
- Cache only deterministic/non-session requests.
- Keep background analysis in Queue/Workflow.
- Use bindings directly instead of calling Cloudflare REST APIs from the Worker.
- Keep the live voice path small.

Cloudflare recommends bindings for direct access to D1/KV/R2/Queues/Workflows and recommends Queues/Workflows for work that should not block a request. citeturn0search10

## Security rules

- Never commit API keys.
- Treat resume/JD/interview text as untrusted data.
- Enforce upload size/type limits.
- Isolate user/session objects.
- Expire sessions.
- Add rate limiting before public production exposure.
- Use least-privilege Cloudflare tokens for CI/CD.

## Cloudflare architecture

Workers, D1, KV, R2, Durable Objects, Queues and Workflows form the primary platform. Cloudflare describes Workers as supporting these bindings and AI/background workloads directly. citeturn0search3
