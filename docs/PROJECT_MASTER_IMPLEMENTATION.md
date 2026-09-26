# AI-Answer-Agent — Master Implementation

This document is the single checklist for the interview-first AI assistant and the selected JARVIS capabilities.

## Product goal

Build an interview-first assistant with realtime voice, grounded answers, resume/JD/project memory, interview coaching, and optional desktop-assistant capabilities.

## Desktop

- Low-latency microphone capture/VAD/turn management.
- Streaming STT and streaming answer playback.
- Wake-word gate.
- OCR/vision already present.
- JARVIS command registry with explicit allowlisting.
- Bounded command history.
- Local CPU/memory diagnostics.
- Personality preferences.
- Opt-in reminders.
- Opt-in proactive suggestions.
- TTS interruption/queue behavior remains in the existing voice stack.
- Risky desktop actions require confirmation.

## Worker / Cloudflare

- One canonical Worker entrypoint.
- API authentication and rate limits.
- Durable Objects for realtime interview session coordination.
- D1 for persistent sessions, turns, quality and reports.
- KV for hot cache/configuration.
- R2 for resume/JD/transcript/report objects.
- Queues for non-blocking background work.
- Workflows for durable post-interview analysis.
- Workers AI for lightweight/free-first inference tasks.
- AI Gateway/model routing where configured.
- Vectorize + embeddings for resume/JD/project retrieval.

## Interview intelligence

- Technical, behavioral, coding and system-design modes.
- DevOps/cloud/Kubernetes/Terraform/AWS-aware context.
- Resume and job-description grounding.
- Unsupported-experience guardrails.
- Answer quality signals: relevance, clarity, completeness and grounding.
- Follow-up suggestions.
- Per-turn analytics.
- Post-interview report.

## Voice

Mic -> local VAD -> streaming STT -> stable transcript -> question detection -> grounded retrieval -> AI answer -> streaming UI/TTS.

The desktop remains responsible for continuous audio capture and low-level audio processing. Cloudflare coordinates realtime state and AI/backend operations.

## JARVIS integration policy

Reuse useful JARVIS concepts, not the entire Python runtime.

Included concepts:
- wake word
- command registry
- command history
- system diagnostics
- personality
- reminders
- opt-in proactive behavior
- vision/OCR integration points
- provider fallback concepts through the existing AI router

Explicitly excluded:
- unrestricted shell execution
- stealth/anti-detection behavior
- hidden automation
- biometric authentication dependency
- automatic phone/SMS/WhatsApp actions
- duplicate Python audio/STT runtime

## Cost policy

Prefer Cloudflare Free-plan resources and graceful degradation. Optional bindings must not make local development or the core interview flow fail when they are not provisioned.

## Test gates

- Worker interview tests
- Worker retrieval tests
- Desktop voice tests
- Desktop JARVIS capability tests
- Cloudflare preflight
- End-to-end voice test
- Real interview simulation
- Production security/rate-limit validation

## Source of truth

All continuing implementation work belongs on `audit/security-realtime-fixes` unless the user explicitly requests another branch.
