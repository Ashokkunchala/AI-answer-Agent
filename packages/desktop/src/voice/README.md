# Voice Service

The voice layer provides the AI-answer-Agent audio/STT pipeline and assistant session behavior.

## Responsibilities

- Provider-agnostic voice session state
- Partial and final transcript events
- Voice intent classification
- TTS adapter with interruption support
- A single integration point for Electron IPC and the AI backend

The existing DSP/VAD/STT providers remain responsible for microphone capture and transcription. This layer does not replace Deepgram, Whisper, or the existing audio pipeline.
