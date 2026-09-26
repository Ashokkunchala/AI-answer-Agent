# JARVIS -> AI-Answer-Agent integration manifest

Reviewed repositories:
- Ashokkunchala/jarvis-ai-assistant
- Ashokkunchala/AI-answer-Agent branch audit/security-realtime-fixes

Selected reusable JARVIS capabilities for the Electron desktop client:
1. Configurable wake-word activation.
2. Modular natural-language command catalog/registry.
3. Command history with structured command/result telemetry.
4. System diagnostics: CPU, memory, disk, network, battery/thermal snapshots.
5. Personality/response-style configuration, implemented locally without mandatory external AI calls.
6. TTS queue/interrupt/rate/volume/voice selection concepts.
7. Ambient awareness as an opt-in local feature, kept off by default and privacy-bounded.
8. Proactive/reminder concepts for desktop-side scheduling, with explicit user opt-in.
9. Vision/scene-analysis ideas as an optional desktop vision adapter, reusing the existing OCR/vision stack rather than Python camera loops.
10. Provider fallback concept: preserve AI-Answer-Agent's existing Cloudflare model routing first; optional external provider fallback remains behind explicit configuration.

Not imported:
- unrestricted shell/terminal execution;
- stealth/anti-detection/fingerprinting;
- hidden automation;
- biometric/face-auth;
- automatic SMS/phone/WhatsApp actions;
- large Python JARVIS runtime;
- PyAudio/speech_recognition loops that duplicate the existing Windows audio/STT pipeline.

Implementation target:
- put voice/command UX in packages/desktop;
- keep Cloudflare Worker focused on routing, interview intelligence, persistence, RAG and background work;
- all desktop actions must use an explicit allowlist and confirmation for risky actions;
- interview mode remains the primary path.
