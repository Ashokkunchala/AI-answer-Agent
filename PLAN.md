# Implementation Plan: DevOps AI Agent Suite - Full Stack

## Executive Summary

The codebase has **multiple duplicate implementations** that need consolidation. The plan addresses:
- UI layout matching the spec (Section 9)
- Windows WASAPI audio engine (Section 10)
- Audio quality pipeline (Section 11)
- Voice Activity Detection (Section 12)
- Streaming STT (Section 13)
- Technical vocabulary (Section 14)
- AI answer engine (Section 15)
- Latency targets (Section 16)

---

## Phase 1: Consolidate & Fix Critical Issues

### 1.1 Remove Duplicate Implementations

**Files to consolidate:**
- `packages/desktop/src/voice-service.js` (601 lines) - KEEP as primary
- `packages/desktop/renderer/voice/voice-service.js` (853 lines) - REMOVE (duplicate)
- `packages/desktop/src/renderer/voice-service.js` (381 lines) - REMOVE (duplicate)
- `packages/desktop/src/renderer/voice-service.js.bak2` - REMOVE
- `packages/desktop/src/voice-service.js.bak` - REMOVE

- `packages/desktop/renderer/voice/vad.js` (209 lines) - KEEP as primary VAD
- `packages/desktop/src/voice/VoiceActivityDetector.ts` (123 lines) - REMOVE (duplicate)

- `packages/desktop/renderer/voice/audioCapture.js` (357 lines) - KEEP for browser fallback
- `packages/desktop/src/voice/AudioCapture.ts` (91 lines) - REMOVE (buggy, duplicate)

- `packages/desktop/src/providers/deepgram.js` (203 lines) - KEEP as primary STT
- `packages/desktop/src/voice/SpeechToTextProvider.ts` (150 lines) - REMOVE (duplicate)

**Fix bugs in TypeScript voice module:**
- `VoiceSession.ts:122` - Fix `this.lasthVadUpdate` typo → `this.lastVadUpdate`
- `SpeechToTextProvider.ts:70` - Fix missing template literal backticks

### 1.2 Fix IPC Event Mismatch

**Current issue:** `components-init.js` listens for events that main process doesn't send.

**Fix in `components-init.js._wireIPC()`:**
```javascript
// Change from non-existent events to actual events:
window.electronAPI.onAnswerStream?.((data) => {
  this.components.answerPanel?.updateLastAnswer(data.answer || '');
});

window.electronAPI.onAnswerReady?.((data) => {
  this.components.answerPanel?.addAnswer(data);
});

window.electronAPI.onStatusUpdate?.((status) => {
  this.components.connStatus?.update({ connected: status === 'connected' });
});
```

**Fix in `components-init.js._buildOverlay()`:**
- Add `ModeSelector` instantiation
- Add `InterviewInput` instantiation
- Wire mode change IPC to main process

---

## Phase 2: UI Layout (Section 9)

### 2.1 Match Spec Layout

The spec requires:
```
┌─────────────────────────────────────────────┐
│ ✦ AI-Answer-Agent     AUTO    🎧    00:24:18   − □ ×│
├─────────────────────────────────────────────┤
│ ● Interview audio connected                │
│ Chrome / Google Meet                        │
├─────────────────────────────────────────────┤
│ ▁▂▃▆▇▅▃▂▁▃▆▇▅▂                            │
│ ● LISTENING TO INTERVIEW                   │
├─────────────────────────────────────────────┤
│ INTERVIEWER                                 │
│ "Can you explain how Kubernetes handles    │
│ rolling deployments?"                      │
├─────────────────────────────────────────────┤
│ AI ANSWER                                   │
│ A Kubernetes Deployment manages the        │
│ desired state of application Pods...        │
│ [Short] [Normal] [Detailed]    [Copy]       │
├─────────────────────────────────────────────┤
│ Context: AWS + Kubernetes + DevOps          │
│ Ask AI anything...                     ➤   │
└─────────────────────────────────────────────┘
```

### 2.2 Component Updates

**Update `AIHeader.js`:**
- Add mode badge ("AUTO" / selected mode)
- Add audio source indicator icon
- Match exact layout from spec

**Update `components-init.js._buildOverlay()`:**
- Add `ModeSelector` after header
- Add `AudioVisualizer` between status and transcript
- Add `InterviewInput` at bottom
- Add `AnswerModeSelector` in answer panel
- Add `ContextStatus` display

**Update `AIAnswerPanel.js`:**
- Add `AnswerModeSelector` (Short/Normal/Detailed)
- Add `AnswerControls` (Copy button)
- Support streaming display

**Update `TranscriptPanel.js`:**
- Show "INTERVIEWER" label
- Show speaker identification
- Show detected audio source (Chrome/Google Meet)

---

## Phase 3: Windows Audio Engine (Section 10)

### 3.1 Architecture

```
┌─────────────────────────────────────────┐
│          AudioSourceManager             │
│  ┌─────────────────────────────────┐   │
│  │    WindowsAudioCapture (WASAPI) │   │
│  │  ┌─────────────────────────┐   │   │
│  │  │ Application Loopback    │   │   │
│  │  │ (Chrome, Edge, Meet,    │   │   │
│  │  │  Teams, Zoom)           │   │   │
│  │  └─────────────────────────┘   │   │
│  │  ┌─────────────────────────┐   │   │
│  │  │ Render Device Loopback  │   │   │
│  │  │ (Fallback)              │   │   │
│  │  └─────────────────────────┘   │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

### 3.2 Implementation

**Create `packages/desktop/src/audio/` directory:**

**`audio-source-manager.js`** - Main orchestrator:
```javascript
class AudioSourceManager {
  async enumerateSources()        // List all available audio sources
  async selectSource(sourceId)    // Choose capture source
  async startCapture()            // Begin WASAPI capture
  async stopCapture()             // Stop capture
  onAudioData(callback)           // Stream PCM data
  onSourceChanged(callback)       // Source change events
}
```

**`windows-audio-capture.js`** - WASAPI interface:
```javascript
class WindowsAudioCapture {
  // Uses koffi to call Windows APIs
  async initWASAPI()
  async enumerateEndpoints()      // IMMDeviceEnumerator
  async openCaptureStream(deviceId)
  async readAudioFrames()         // IAudioCaptureClient
  getAudioFormat()                // WAVEFORMATEX
}
```

**`audio-processing-pipeline.js`** - DSP chain:
```javascript
class AudioProcessingPipeline {
  // Chain: channel → resample → highpass → noise → enhance → normalize → VAD → classify
  process(frame)                  // Process single frame
  configure(settings)             // Update pipeline settings
  getMetrics()                    // Get processing stats
}
```

### 3.3 WASAPI Integration

**Create `packages/desktop/src/audio/wasapi-bindings.js`:**
```javascript
const koffi = require('koffi');

// Load Windows APIs
const ole32 = koffi.load('ole32.dll');
const mmdevapi = koffi.load('mmdevapi.dll');
const avrt = koffi.load('avrt.dll');

// COM interfaces
const IID_IMMDeviceEnumerator = '{A95664D2-9614-4F35-A746-DE8DB63617E6}';
const IID_IAudioCaptureClient = '{C8ADBD64-E7ED-4236-951C-8910002526C4}';
const IID_IAudioClient = '{1CB9AD4C-DBFA-43de-82EA-123080002965}';
```

**Key Windows APIs to use:**
- `CoCreateInstance` - Create COM objects
- `IMMDeviceEnumerator` - Enumerate audio devices
- `IMMDevice` - Audio endpoint device
- `IAudioClient` - Audio stream access
- `IAudioCaptureClient` - Capture audio data
- `WaveFormatEx` - Audio format description

### 3.4 Process Loopback (Windows 10+)

```javascript
// Application-specific capture
const IID_IAudioSessionManager2 = '{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}';
const IID_IAudioSessionEnumerator = '{E2F5BB12-75AA-4407-9A26-7F4396B87BAC}';

async function captureProcessAudio(processId) {
  // 1. Get IAudioSessionManager2
  // 2. Get IAudioSessionEnumerator
  // 3. Find session by process ID
  // 4. Get IAudioSessionControl
  // 5. Start capture loop
}
```

---

## Phase 4: Audio Quality Pipeline (Section 11)

### 4.1 Pipeline Implementation

**`audio-processing-pipeline.js`** (continued):

```javascript
class AudioProcessingPipeline {
  constructor() {
    this.stages = [
      new ChannelHandler(),      // Mono/Stereo handling
      new Resampler(),           // 48kHz → 16kHz for STT
      new HighPassFilter(),      // Remove low-freq rumble (< 80Hz)
      new NoiseSuppressor(),     // RNNoise-based noise reduction
      new SpeechEnhancer(),      // Frequency emphasis for speech
      new LevelNormalizer(),     // RMS-based volume normalization
      new VoiceActivityDetector(), // VAD
      new SpeechClassifier(),    // Speech vs non-speech
    ];
  }

  async processFrame(frame) {
    let processed = frame;
    for (const stage of this.stages) {
      processed = await stage.process(processed);
    }
    return processed;
  }
}
```

### 4.2 Noise Suppression

**Option A: WebRTC Noise Suppression (Recommended)**
- Use `libwebrtc` via native addon or Emscripten
- Apply RNNoise model for ML-based noise reduction

**Option B: Browser Built-in**
- Keep current `noiseSuppression: true` as fallback
- Not ideal for production quality

**Create `packages/desktop/src/audio/noise-suppressor.js`:**
```javascript
class NoiseSuppressor {
  constructor() {
    // Load RNNoise model or use WebRTC
    this.model = null;
  }

  async init() {
    // Load ML model for noise suppression
  }

  process(frame) {
    // Apply noise reduction
    // Preserve speech frequencies (300Hz - 3400Hz)
    // Suppress: keyboard, mouse, fan, AC, hum, static
    return processed;
  }
}
```

### 4.3 Reject/Suppress List

**Implement filters for:**
- Keyboard clicks (high-frequency transient)
- Mouse clicks (short burst, 1-5kHz)
- Fan noise (low-frequency constant, < 200Hz)
- AC noise (50/60Hz hum + harmonics)
- Static/hiss (broadband noise)
- Notifications (alert sounds)
- Silence (VAD-based gating)
- Non-speech sounds (ML classification)

**Preserve:**
- Human voice (85Hz - 300Hz fundamental)
- Word endings (-ing, -tion, -s)
- Word beginnings (plosives, fricatives)
- Numbers ("three" vs "free")
- Acronyms ("AWS", "GCP", "CI/CD")
- Technical terms ("Kubernetes", "Terraform")

---

## Phase 5: Voice Activity Detection (Section 12)

### 5.1 State Machine

```
IDLE ──→ LISTENING ──→ SPEAKING ──→ SILENCE ──→ FINALIZING ──→ IDLE
  ↑         ↑              ↑            ↑              │
  │         │              │            │              │
  └─────────┴──────────────┴────────────┘              │
                         ↑                             │
                         └─────────────────────────────┘
                              (on speech start)
```

### 5.2 Implementation

**Update `packages/desktop/renderer/voice/vad.js`:**

```javascript
class VoiceActivityDetector {
  constructor(config = {}) {
    this.config = {
      // Thresholds
      speechThreshold: config.speechThreshold || 0.015,
      silenceThreshold: config.silenceThreshold || 0.008,

      // Timing
      minSpeechDuration: config.minSpeechDuration || 200,  // ms
      minSilenceDuration: config.minSilenceDuration || 800, // ms
      preRollDuration: config.preRollDuration || 300,       // ms
      postRollDuration: config.postRollDuration || 500,     // ms

      // Hangover (prevents clipping)
      hangoverDuration: config.hangoverDuration || 300,     // ms

      // Adaptive threshold
      adaptiveEnabled: config.adaptiveEnabled || true,
      noiseFloorAlpha: config.noiseFloorAlpha || 0.1,       // smoothing
    };

    this.state = 'IDLE';
    this.noiseFloor = 0;
    this.energyHistory = [];
  }

  // State transitions
  onSpeechStart()    // → LISTENING
  onSpeechContinue() // → SPEAKING
  onSpeechEnd()      // → SILENCE
  onFinalize()       // → FINALIZING → IDLE

  // Pre-roll: capture audio before speech start
  getPreRollBuffer() // Returns last N ms of audio

  // Post-roll: continue capture after speech end
  getPostRollBuffer() // Returns audio after speech end

  // Natural pause handling
  handlePause(duration) {
    // Short pause (< 500ms): keep in SPEAKING
    // Medium pause (500ms - 1s): move to SILENCE
    // Long pause (> 1s): finalize
  }
}
```

### 5.3 Pre-roll & Post-roll

```javascript
// Circular buffer for pre-roll
this.preRollBuffer = new Float32Array(preRollDuration * sampleRate / 1000);
this.preRollIndex = 0;

onAudioFrame(frame) {
  // Always push to pre-roll buffer (circular)
  this.preRollBuffer[this.preRollIndex] = frame;
  this.preRollIndex = (this.preRollIndex + 1) % this.preRollBuffer.length;

  // Check VAD
  if (this.state === 'IDLE' && this.detectSpeech(frame)) {
    // Include pre-roll in transcript
    this.emit('speech-start', {
      preRoll: this.preRollBuffer.slice(this.preRollIndex),
      timestamp: Date.now()
    });
  }
}

onSpeechEnd() {
  // Wait for post-roll before finalizing
  setTimeout(() => {
    this.emit('speech-end', {
      postRoll: this.currentBuffer,
      timestamp: Date.now()
    });
  }, this.config.postRollDuration);
}
```

---

## Phase 6: Streaming STT (Section 13)

### 6.1 Provider Abstraction

**Update `packages/desktop/src/providers/base.js`:**

```javascript
class RealtimeSpeechProvider {
  constructor(config) {
    this.config = config;
    this.sessionId = null;
    this.isConnected = false;
  }

  // Connection management
  async connect() {}
  async disconnect() {}
  async reconnect() {}

  // Audio streaming
  sendAudio(audioData) {}
  sendClose() {}

  // Event callbacks
  onPartialTranscript(callback) {}
  onFinalTranscript(callback) {}
  onError(callback) {}
  onConnected(callback) {}
  onDisconnected(callback) {}
  onLatency(callback) {}

  // Session management
  getSessionId() {}
  isSessionActive() {}
}
```

### 6.2 Persistent Session

**Create `packages/desktop/src/stt-session.js`:**

```javascript
class STTSession {
  constructor(provider) {
    this.provider = provider;
    this.sessionId = this.generateSessionId();
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
  }

  async maintain() {
    // Auto-reconnect on disconnect
    // Exponential backoff
    // Session state persistence
  }

  async sendAudioChunk(chunk) {
    // Accumulate audio
    // Send when connected
    // Buffer if disconnected
  }

  getPartialTranscript() {
    // Return current partial transcript
  }

  getFinalTranscript() {
    // Return accumulated final transcript
  }
}
```

### 6.3 Update VoiceService Integration

**Update `packages/desktop/src/voice-service.js`:**

```javascript
async startListening() {
  // Connect to persistent STT session
  if (!this.sttSession) {
    this.sttSession = new STTSession(this.sttProvider);
    await this.sttSession.connect();
  }

  // Start audio capture
  await this.audioCapture.start();

  // Wire events
  this.sttSession.onPartialTranscript((text) => {
    this.interimTranscript = text;
    this.emit('partial-transcript', text);
  });

  this.sttSession.onFinalTranscript((text) => {
    this.finalTranscript += text;
    this.emit('final-transcript', text);
  });
}
```

---

## Phase 7: Technical Vocabulary (Section 14)

### 7.1 Vocabulary List

**Create `packages/desktop/src/vocabulary.js`:**

```javascript
const TECHNICAL_VOCABULARY = {
  cloud: ['AWS', 'Azure', 'GCP', 'EKS', 'ECS', 'EC2', 'S3', 'IAM', 'VPC', 'Lambda'],
  containers: ['Kubernetes', 'Docker', 'Pod', 'Deployment', 'Service', 'Ingress',
               'ConfigMap', 'Secret', 'StatefulSet', 'DaemonSet', 'HPA', 'Helm'],
  cicd: ['Jenkins', 'GitHub Actions', 'CI/CD', 'Pipeline', 'Workflow'],
  infrastructure: ['Terraform', 'Ansible', 'CloudFormation', 'Pulumi'],
  networking: ['DNS', 'TCP', 'UDP', 'HTTP', 'HTTPS', 'Load Balancer', 'Proxy'],
  programming: ['Linux', 'C++', 'Python', 'Java', 'SQL', 'Bash', 'PowerShell'],
  architecture: ['Microservices', 'Serverless', 'Event-Driven', 'REST', 'gRPC'],
};

// Phoneme corrections for common misrecognitions
const PHONEME_CORRECTIONS = {
  'kubernetes': ['koo-ber-net-ees', 'cube-er-net-iss'],
  'docker': ['dock-er'],
  'terraform': ['ter-ra-form'],
  'jenkins': ['jen-kins'],
  'github': ['git-hub'],
  'cicd': ['see-eye-see-dee'],
  'eks': ['ee-kay-ess'],
  'ecs': ['ee-see-ess'],
  'ec2': ['ee-see-two'],
  's3': ['ess-three'],
  'iam': ['eye-aye-em'],
  'vpc': ['vee-pee-see'],
  'lambda': ['lam-da'],
  'helm': ['helm'],
  'ansible': ['an-si-ble'],
  'pod': ['pod'],
  'deployment': ['de-ploy-ment'],
  'service': ['ser-vice'],
  'ingress': ['in-gress'],
  'configmap': ['config-map'],
  'statefulset': ['state-ful-set'],
  'daemonset': ['day-mon-set'],
  'hpa': ['aitch-pee-ay'],
};

module.exports = { TECHNICAL_VOCABULARY, PHONEME_CORRECTIONS };
```

### 7.2 STT Configuration

**Update Deepgram connection:**
```javascript
const endpoint = `wss://api.deepgram.com/v1/listen?model=nova-3&language=en&encoding=linear16&sample_rate=48000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000&smart_format=true&keywords=${encodeURIComponent(technicalKeywords)}`;
```

### 7.3 Post-Processing

**Create `packages/desktop/src/transcript-processor.js`:**

```javascript
class TranscriptProcessor {
  process(transcript) {
    // 1. Apply vocabulary corrections
    let corrected = this.applyCorrections(transcript);

    // 2. Fix common misrecognitions
    corrected = this.fixMisrecognitions(corrected);

    // 3. Preserve technical terms
    corrected = this.preserveTerms(corrected);

    return corrected;
  }

  applyCorrections(text) {
    // Replace misrecognized words with correct technical terms
    for (const [correct, variants] of Object.entries(PHONEME_CORRECTIONS)) {
      for (const variant of variants) {
        text = text.replace(new RegExp(variant, 'gi'), correct);
      }
    }
    return text;
  }

  preserveTerms(text) {
    // Ensure technical terms are not modified
    const terms = Object.values(TECHNICAL_VOCABULARY).flat();
    for (const term of terms) {
      const regex = new RegExp(`\\b${term}\\b`, 'gi');
      text = text.replace(regex, term);
    }
    return text;
  }
}
```

---

## Phase 8: AI Answer Engine (Section 15)

### 8.1 Architecture

```
┌─────────────────────────────────────────────┐
│              AI Answer Engine               │
├─────────────────────────────────────────────┤
│  Final Transcript                           │
│         ↓                                   │
│  Question Classifier                        │
│  (code_gen, debug, review, explain, etc.)   │
│         ↓                                   │
│  Context Builder                            │
│  (resume + job desc + meeting context)      │
│         ↓                                   │
│  System Prompt Selector                     │
│  (per task type prompts)                    │
│         ↓                                   │
│  AI Request (streaming)                     │
│         ↓                                   │
│  Response Stream → UI                       │
└─────────────────────────────────────────────┘
```

### 8.2 Implementation

**Update `packages/desktop/src/main.js`:**

```javascript
// Question classification
const { classifyQuestion } = require('./classifier');

// System prompts per task type
const TASK_PROMPTS = {
  code_gen: 'You are a senior DevOps engineer. Generate production-ready code...',
  debug: 'You are a debugging expert. Analyze the issue systematically...',
  review: 'You are a code reviewer. Provide constructive feedback...',
  explain: 'You are a technical educator. Explain clearly and concisely...',
  interview: 'You are an interview coach. Give concise, accurate answers...',
};

async function queryAI(prompt, onDelta, history, taskType = 'interview') {
  // 1. Classify question
  const classification = taskType || classifyQuestion(prompt);

  // 2. Build system prompt
  let systemPrompt = TASK_PROMPTS[classification] || TASK_PROMPTS.interview;

  // 3. Add context
  if (config.resume) systemPrompt += `\n\n## MY RESUME:\n${config.resume}`;
  if (config.jobDesc) systemPrompt += `\n\n## TARGET ROLE:\n${config.jobDesc}`;

  // 4. Build messages
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(0, 12),
    { role: 'user', content: prompt }
  ];

  // 5. Stream response
  return await streamRequest(base, {
    model: config.model || 'auto',
    messages,
    max_tokens: 300,
    temperature: 0.1,
    stream: true
  }, onDelta);
}
```

### 8.3 Streaming UI

**Update `components-init.js`:**

```javascript
// Wire streaming to UI
window.electronAPI.onAnswerStream?.((data) => {
  const panel = this.components.answerPanel;
  if (panel) {
    if (!panel.currentStreamingCard) {
      panel.currentStreamingCard = panel.createStreamingCard();
    }
    panel.currentStreamingCard.updateAnswer(data.answer);
  }
});

window.electronAPI.onAnswerReady?.((data) => {
  const panel = this.components.answerPanel;
  if (panel) {
    panel.finalizeStreamingCard(data);
  }
});
```

---

## Phase 9: Latency Targets (Section 16)

### 9.1 Latency Measurement

**Create `packages/desktop/src/latency-tracker.js`:**

```javascript
class LatencyTracker {
  constructor() {
    this.marks = {};
    this.metrics = {};
  }

  mark(name) {
    this.marks[name] = performance.now();
  }

  measure(start, end) {
    return this.marks[end] - this.marks[start];
  }

  getMetrics() {
    return {
      // Capture latency
      captureLatency: this.measure('captureStart', 'firstAudioFrame'),

      // VAD latency
      vadLatency: this.measure('speechStart', 'vadSpeechStart'),

      // STT latency
      sttFirstPartial: this.measure('firstAudioSent', 'firstPartialTranscript'),
      sttFinal: this.measure('speechEnd', 'finalTranscript'),

      // AI latency
      aiFirstToken: this.measure('aiRequestStart', 'firstLLMToken'),
      aiFirstUseful: this.measure('aiRequestStart', 'firstUsefulAnswer'),

      // Total latency
      totalLatency: this.measure('speechEnd', 'firstUsefulAnswer'),

      // Breakdown
      breakdown: {
        capture: this.measure('captureStart', 'firstAudioFrame'),
        vad: this.measure('speechStart', 'vadSpeechStart'),
        stt: this.measure('firstAudioSent', 'finalTranscript'),
        ai: this.measure('aiRequestStart', 'firstUsefulAnswer'),
        ui: this.measure('firstUsefulAnswer', 'uiRender'),
      }
    };
  }
}
```

### 9.2 Target: 1.5-2.0 Seconds

**Optimization strategies:**

1. **Reduce VAD latency:**
   - Use smaller analysis windows (10ms frames)
   - Implement look-ahead (predict speech start)

2. **Reduce STT latency:**
   - Use streaming STT (Deepgram Nova-3)
   - Send partial transcripts immediately
   - Don't wait for final transcript to start AI

3. **Reduce AI latency:**
   - Use fast models (llama-3.2-3b)
   - Stream first token immediately
   - Start showing answer before complete

4. **Reduce UI latency:**
   - Virtual DOM diffing
   - RequestAnimationFrame batching
   - Minimize DOM mutations

### 9.3 Never Fake Metrics

**Implementation:**
```javascript
// All timestamps use performance.now() (high-resolution timer)
// Never round or approximate
// Log all measurements for verification
// Display raw metrics in debug mode
```

---

## Phase 10: Integration & Testing

### 10.1 Wire Everything Together

**Update `components-init.js`:**

```javascript
async init() {
  // 1. Initialize audio engine
  this.audioEngine = new AudioSourceManager();
  await this.audioEngine.init();

  // 2. Initialize VAD
  this.vad = new VoiceActivityDetector();
  this.vad.onSpeechStart(() => this.onSpeechStart());
  this.vad.onSpeechEnd(() => this.onSpeechEnd());

  // 3. Initialize STT
  this.stt = new STTSession(new DeepgramProvider());
  await this.stt.connect();

  // 4. Initialize AI
  this.ai = new AIAnswerEngine();

  // 5. Wire events
  this.audioEngine.onAudioData((frame) => {
    this.vad.processFrame(frame);
    if (this.vad.isSpeaking()) {
      this.stt.sendAudioChunk(frame);
    }
  });

  this.stt.onFinalTranscript((text) => {
    this.ai.query(text);
  });

  this.ai.onStreamDelta((delta) => {
    this.components.answerPanel?.updateStreaming(delta);
  });
}
```

### 10.2 Testing

**Create `packages/desktop/src/tests/` directory:**

- `audio-engine.test.js` - Test WASAPI capture
- `vad.test.js` - Test VAD state machine
- `stt.test.js` - Test streaming STT
- `pipeline.test.js` - Test audio processing
- `latency.test.js` - Test latency measurement

**Run tests:**
```bash
cd packages/desktop
npm test
```

---

---

## Phase 11: Worker Backend Changes

### 11.1 Current Worker-Desktop Communication

**Only 3 endpoints are used by the desktop:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /v1/chat/completions` | SSE streaming | AI chat responses |
| `POST /v1/audio/transcriptions` | HTTP POST | Batch STT (Whisper) |
| `GET /health` | HTTP GET | Health check |

**External (bypasses worker):**
- Deepgram WebSocket (`wss://api.deepgram.com/v1/listen`) - direct streaming STT

### 11.2 What Worker DOES vs What Desktop NEEDS

| Feature | Worker Has | Desktop Needs | Gap |
|---------|-----------|---------------|-----|
| Chat completions (streaming) | YES | YES | ✅ Aligned |
| Batch STT (Whisper) | YES | YES | ✅ Aligned |
| Streaming STT (WebSocket) | YES (`/voice-socket`) | Desktop uses Deepgram directly | ⚠️ Desktop bypasses worker |
| Health check | YES | YES | ✅ Aligned |
| Model routing | YES (12 task types) | Desktop hardcodes 4-model fallback | ⚠️ Desktop doesn't use worker routing |
| System prompts | YES (7 task-specific) | Desktop builds its own prompt | ⚠️ Desktop ignores worker prompts |
| API key management | YES | Desktop manages keys | ✅ Aligned |
| Usage tracking | YES | Desktop doesn't track | ⚠️ Desktop ignores usage |
| Rate limiting | STORED (not enforced) | N/A | ⚠️ No enforcement |

### 11.3 Critical Mismatches to Fix

**Mismatch 1: Desktop builds its own system prompt**
- `main.js:726-746` builds a custom prompt with resume/job context
- Worker's `system-prompts.js` has `BASE_SYSTEM_PROMPT` + 7 task-specific prompts
- Desktop completely ignores worker prompts
- **Fix:** Desktop should send `task_type` to worker, let worker handle prompt injection

**Mismatch 2: Desktop hardcodes model fallback chain**
- `main.js:749-754` tries: `config.model` → `llama-3.2-3b` → `llama-3.2-1b` → `llama-3.1-8b`
- Worker has 12 task-specific chains with 3-6 models each
- Desktop ignores worker routing
- **Fix:** Desktop should send `model: "auto"` and let worker route

**Mismatch 3: IPC event names don't match**
- Desktop components listen for: `ai-response-chunk`, `voice-level`, `vad-state`, `connection-update`, `agent-error`, `mode-changed`
- Main process sends: `answer-stream`, `answer-ready`, `status-update`, `toggle-mic`
- **Fix:** Align event names in `components-init.js`

**Mismatch 4: Desktop doesn't use worker's `/voice-socket`**
- Worker has WebSocket endpoint for streaming voice transcription
- Desktop uses Deepgram directly (requires separate API key)
- **Fix:** Either use worker WebSocket or keep Deepgram (user preference)

### 11.4 Worker Changes Needed

**Change 1: Support resume/job context in system prompt**

Update worker's `buildSystemPrompt()` to accept context:

```javascript
// worker/src/system-prompts.js
function buildSystemPrompt(taskType, options = {}) {
  let prompt = BASE_SYSTEM_PROMPT;
  if (TASK_SPECIFIC_PROMPTS[taskType]) {
    prompt += '\n\n' + TASK_SPECIFIC_PROMPTS[taskType];
  }
  if (options.resume) {
    prompt += `\n\n## MY RESUME / EXPERIENCE:\n${options.resume}`;
  }
  if (options.jobDesc) {
    prompt += `\n\n## TARGET ROLE / JOB DESCRIPTION:\n${options.jobDesc}`;
  }
  if (options.targetName) {
    prompt += `\n\n## MEETING CONTEXT:\nThe person asking questions is likely "${options.targetName}". Address them professionally.`;
  }
  if (options.participants?.length) {
    prompt += `\n\n## PARTICIPANTS IN MEETING:\n${options.participants.join(', ')}`;
  }
  if (options.customPrompt) {
    prompt += `\n\n## Additional User Instructions\n${options.customPrompt}`;
  }
  return prompt;
}
```

**Change 2: Accept context in request body**

Update `router.js` to pass context from request body:

```javascript
// worker/src/router.js
const context = {
  resume: body.resume,
  jobDesc: body.jobDesc,
  targetName: body.targetName,
  participants: body.participants,
  customPrompt: body.system
};
messages = injectSystemPrompt(messages, taskType, null, context);
```

**Change 3: Return latency breakdown in response**

Update response metadata:

```javascript
// worker/src/router.js
metadata: {
  latency_ms: elapsed,
  model_chain_position: i,
  total_models_tried: chain.length,
  task_type: taskType,
  token_usage: response.usage || null
}
```

**Change 4: Add streaming latency markers**

Add timing markers to SSE stream:

```javascript
// worker/src/index.js
// Before first token
writer.write(`data: {"type":"marker","name":"ai_response_start","timestamp":${Date.now()}}\n\n`);

// After first token
writer.write(`data: {"type":"marker","name":"first_token","timestamp":${Date.now()}}\n\n`);
```

### 11.5 Desktop Changes Needed

**Change 1: Simplify `queryAI()` to use worker routing**

```javascript
// desktop/src/main.js - simplified queryAI
async function queryAI(prompt, onDelta, history, taskType) {
  const base = config.workerUrl;
  const messages = [
    ...history.slice(0, 12),
    { role: 'user', content: prompt }
  ];

  const payload = {
    model: 'auto',  // Let worker handle routing
    messages,
    max_tokens: 300,
    temperature: 0.1,
    stream: true,
    task_type: taskType,  // Let worker classify
    resume: config.resume,
    jobDesc: config.jobDesc,
    targetName: config.targetName,
    participants: config.participants,
    system: config.customPrompt  // Optional user instructions
  };

  return await streamRequest(base + '/v1/chat/completions', payload, onDelta);
}
```

**Change 2: Fix IPC event alignment**

```javascript
// desktop/renderer/components-init.js
_wireIPC() {
  if (!window.electronAPI) return;

  // Fix: Use actual event names from preload.js
  window.electronAPI.onAnswerStream?.((data) => {
    this.components.answerPanel?.updateLastAnswer(data.answer || '');
  });

  window.electronAPI.onAnswerReady?.((data) => {
    this.components.answerPanel?.addAnswer(data);
    this.components.timer?.stop();
    this.components.header?.update({ status: 'Ready', statusColor: '#22c55e' });
  });

  window.electronAPI.onStatusUpdate?.((status) => {
    this.components.connStatus?.update({ connected: status === 'connected' });
  });

  window.electronAPI.onToggleMic?.(() => {
    this.emit('mic-toggle');
  });
}
```

**Change 3: Pass task type from ModeSelector**

```javascript
// desktop/renderer/components-init.js
_buildOverlay() {
  // ... existing code ...

  // Add ModeSelector
  const modeSelector = new ModeSelector(root, { active: 'interview' });
  modeSelector.render();
  modeSelector.mount();
  this.components.modeSelector = modeSelector;

  // Wire mode changes
  modeSelector.el.addEventListener('mode-change', (e) => {
    this.currentMode = e.detail;
    // Update header title
    const titles = { interview: 'AI Interview', quick_qa: 'Quick Q&A', ... };
    this.components.header?.update({ title: titles[e.detail] || 'AI Agent' });
  });

  // Add InterviewInput
  const input = new InterviewInput(root);
  input.render();
  input.mount();
  this.components.input = input;

  input.el.addEventListener('input-send', (e) => {
    this._handleQuery(e.detail.text);
  });
}

async _handleQuery(text) {
  this.components.timer?.start();
  this.components.header?.update({ status: 'Thinking...', statusColor: '#eab308' });
  this.components.answerPanel?.setLoading(true);

  // Send to worker with task type
  await window.electronAPI.queryAI({
    prompt: text,
    taskType: this.currentMode || 'interview'
  });
}
```

### 11.6 New Worker Endpoint (Optional)

**`POST /v1/audio/realtime`** - For real-time streaming STT through worker

This would allow the desktop to stream audio through the worker instead of using Deepgram directly:

```javascript
// Worker side
export async function handleRealtimeAudio(websocket, env) {
  // Use Deepgram streaming API as backend
  // Forward audio from desktop to Deepgram
  // Forward transcripts back to desktop
  // Add vocabulary corrections
  // Track latency
}
```

**Benefits:**
- No separate Deepgram API key needed
- Worker can add vocabulary corrections
- Centralized latency tracking
- Can use cheaper models for simple transcripts

### 11.7 Updated Communication Flow

```
Desktop Renderer
  ↓ IPC (query-ai with taskType, context)
Desktop Main Process
  ↓ POST /v1/chat/completions
  ↓ Body: { model: 'auto', messages, task_type, resume, jobDesc, ... }
Cloudflare Worker
  ↓ Classify request
  ↓ Inject system prompt (with resume/job context)
  ↓ Route to best model
  ↓ Stream SSE response
Desktop Main Process
  ↓ Parse SSE, emit 'answer-stream' events
Desktop Renderer
  ↓ Update AIAnswerPanel with streaming text
  ↓ Show final answer on 'answer-ready'
```

---

## Implementation Order

| Phase | Description | Effort | Dependencies |
|-------|-------------|--------|--------------|
| 1 | Consolidate duplicates, fix bugs | 2 days | None |
| 2 | UI layout matching spec | 2 days | Phase 1 |
| 3 | Windows WASAPI audio engine | 5 days | Phase 1 |
| 4 | Audio quality pipeline | 3 days | Phase 3 |
| 5 | Voice Activity Detection | 2 days | Phase 4 |
| 6 | Streaming STT | 2 days | Phase 5 |
| 7 | Technical vocabulary | 1 day | Phase 6 |
| 8 | AI Answer Engine | 2 days | Phase 7 |
| 9 | Latency targets | 2 days | Phase 8 |
| 10 | Integration & testing | 3 days | Phase 9 |
| 11 | Worker backend changes | 2 days | Phase 1, Phase 8 |
| **Total** | | **26 days** | |

---

## Critical Path

1. Phase 1 (Consolidate) → Phase 3 (WASAPI) → Phase 4 (Pipeline) → Phase 5 (VAD) → Phase 6 (STT) → Phase 8 (AI) → Phase 11 (Worker) → Phase 10 (Integration)

2. Phase 2 (UI) can run in parallel with Phase 3-6

3. Phase 11 (Worker) can run in parallel with Phase 3-8

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| WASAPI complexity | High | Use Electron's desktopCapturer as fallback |
| koffi limitations | Medium | Test all Windows API calls thoroughly |
| Audio quality | High | ML noise suppression requires model loading |
| Latency targets | High | Profile each stage, optimize hot paths |
| Multiple implementations | Medium | Strict consolidation in Phase 1 |
| Worker prompt mismatch | Medium | Desktop sends context, worker handles prompts |
| Deepgram dependency | Medium | Keep as primary, add worker WebSocket as fallback |
| IPC event mismatch | Low | Align event names in Phase 1 |

---

## Complete File Reference

### Worker Files to Modify

| File | Changes |
|------|---------|
| `packages/worker/src/system-prompts.js` | Add context injection (resume, job, participants) |
| `packages/worker/src/router.js` | Accept context in request body, pass to prompt builder |
| `packages/worker/src/index.js` | Add latency markers to SSE stream, accept context fields |
| `packages/worker/src/config.js` | Add `interview` task type to routing table |

### Desktop Files to Modify

| File | Changes |
|------|---------|
| `packages/desktop/src/main.js` | Simplify `queryAI()` to use worker routing, fix IPC events |
| `packages/desktop/renderer/components-init.js` | Fix IPC event names, add ModeSelector, add InterviewInput |
| `packages/desktop/src/voice-service.js` | Fix IPC event emission to match components |
| `packages/desktop/src/providers/deepgram.js` | Add vocabulary corrections |

### Files to Create

| File | Purpose |
|------|---------|
| `packages/desktop/src/audio/windows-audio-capture.js` | WASAPI interface via koffi |
| `packages/desktop/src/audio/audio-processing-pipeline.js` | DSP chain |
| `packages/desktop/src/audio/noise-suppressor.js` | ML noise reduction |
| `packages/desktop/src/latency-tracker.js` | Centralized latency measurement |
| `packages/desktop/src/vocabulary.js` | Technical term corrections |
| `packages/desktop/src/transcript-processor.js` | Post-processing for STT |

### Files to Remove

| File | Reason |
|------|--------|
| `packages/desktop/renderer/voice/voice-service.js` | Duplicate of `src/voice-service.js` |
| `packages/desktop/src/renderer/voice-service.js` | Duplicate |
| `packages/desktop/src/renderer/voice-service.js.bak2` | Backup file |
| `packages/desktop/src/voice-service.js.bak` | Backup file |
| `packages/desktop/src/voice/VoiceActivityDetector.ts` | Duplicate of `renderer/voice/vad.js` |
| `packages/desktop/src/voice/AudioCapture.ts` | Buggy duplicate |
| `packages/desktop/src/voice/SpeechToTextProvider.ts` | Duplicate of `providers/deepgram.js` |
