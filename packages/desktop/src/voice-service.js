// Voice Service - Complete voice pipeline
// WASAPI → DSP → VAD → Streaming STT → Transcript Manager → Turn Manager → AI
//
// States: IDLE | LISTENING | SPEAKING | PROCESSING | ERROR
// Manages mic stream, audio context, VAD, STT provider, and performance metrics.
//
// With Deepgram Flux:
//   - Audio frames stream to Deepgram in real-time via WebSocket
//   - Partial transcripts appear as interviewer speaks
//   - Deepgram's server-side VAD detects speech end (EndOfTurn)
//   - TranscriptManager accumulates finals within a turn
//   - TurnManager debounces and emits turn-ready for AI query
//   - No 1200ms local VAD silence wait — Deepgram handles it

import { createProvider, detectBestProvider } from './providers/index.js';
import { AudioVisualizer } from './audio-visualizer.js';
import { PcmAnalyser } from './pcm-analyser.js';
import { TranscriptManager } from './transcript-manager.js';
import { TurnManager } from './turn-manager.js';

export const VoiceState = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  SPEAKING: 'SPEAKING',
  PROCESSING: 'PROCESSING',
  ERROR: 'ERROR',
};

export class VoiceService {
  constructor(config = {}) {
    this.config = Object.assign({
        audioSource: 'engine',
        audioSourceId: null,
        audioSourceName: null,
        engineProcessName: null,
      }, config);
    this.state = VoiceState.IDLE;

    // Windows Audio Engine (WASAPI loopback) mode — captures system/process
    // audio in the main process and streams DSP-processed 16kHz frames here.
    this.engineMode = ['engine', 'loopback', 'audio-engine', 'wasapi']
      .includes(String(this.config.audioSource || '').toLowerCase());
    this._engineLevel = 0;
    this._engineVad = false;
    this._engineRemoveFns = null;

    // Audio
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.processorNode = null;

    // STT
    this.sttProvider = null;
    this.sttType = config.sttType ?? 'auto';

    // VAD
    this.vadThreshold = config.vadThreshold ?? 0.015;
    this.vadSilenceMs = config.vadSilenceMs ?? 1200;
    this.vadMinSpeechMs = config.vadMinSpeechMs ?? 300;
    this._vadLevel = 0;
    this._speechStartTime = 0;
    this._silenceStartTime = 0;
    this._isSpeaking = false;
    this._vadCheckInterval = null;

    // Transcript
    this.finalTranscript = '';
    this.interimTranscript = '';
    this._autoSendDelay = config.autoSendDelay ?? 1500;
    this._autoSendTimer = null;

    // Transcript & Turn managers (for Deepgram Flux streaming)
    this._transcriptManager = null;
    this._turnManager = null;
    this._useFlux = false;  // true when Deepgram is the active STT provider

    // Visualizer
    this.visualizer = null;

    // Performance metrics
    this.metrics = {
      micConnectMs: 0,
      audioContextMs: 0,
      workletLoadMs: 0,
      sttConnectMs: 0,
      firstPartialMs: 0,
      firstFinalMs: 0,
      speechToPartialMs: 0,
      speechToFinalMs: 0,
      aiLatencyMs: 0,
      totalLatencyMs: 0,
      vadDetectionMs: 0,
      inputLevel: 0,
      chunkCount: 0,
    };

    // Latency instrumentation (T0-T5)
    this._latency = {
      speechEnd: 0,       // T1: VAD detects speech end
      sttFinal: 0,        // T2: final transcript available
      aiRequest: 0,       // T3: AI request begins
      aiFirstToken: 0,    // T4: first useful AI token received
      uiRender: 0,        // T5: first useful answer rendered
      totalMs: 0,         // T5-T0
      _speechStart: 0,    // T0: interviewer stops speaking (track start for context)
      _lastQuestion: '',
      history: [],        // rolling log of last N measurements
    };

    // Events
    this._listeners = new Map();

    // Debug
    this.debug = config.debug || false;

    // Cleanup tracking
    this._timers = [];
    this._intervals = [];
    this._listenersAttached = false;
  }

  // â”€â”€â”€ Event System â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(callback);
  }

  off(event, callback) {
    const cbs = this._listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx >= 0) cbs.splice(idx, 1);
    }
  }

  _emit(event, data) {
    const cbs = this._listeners.get(event) || [];
    for (const cb of cbs) {
      try { cb(data); } catch (e) { console.error(`VoiceService ${event} error:`, e); }
    }
  }

  // â”€â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async start() {
    if (this.state !== VoiceState.IDLE) return;
    const startTime = Date.now();
    console.log('[VoiceService] Starting voice service...');

    try {
      this._setState(VoiceState.LISTENING);
      this.finalTranscript = '';
      this.interimTranscript = '';
      this.metrics = {
        micConnectMs: 0, audioContextMs: 0, workletLoadMs: 0,
        sttConnectMs: 0, firstPartialMs: 0, firstFinalMs: 0,
        speechToPartialMs: 0, speechToFinalMs: 0,
        aiLatencyMs: 0, totalLatencyMs: 0, vadDetectionMs: 0,
        inputLevel: 0, chunkCount: 0,
      };

      this._latency.speechEnd = 0;
      this._latency.sttFinal = 0;
      this._latency.aiRequest = 0;
      this._latency.aiFirstToken = 0;
      this._latency.uiRender = 0;
      this._latency.totalMs = 0;
      this._latency._speechStart = 0;

      // 1. Initialize microphone / audio engine FIRST
      console.log('[VoiceService] Step 1: Initializing microphone...');
      await this._initMicrophone();
      this.metrics.micConnectMs = Date.now() - startTime;
      console.log('[VoiceService] Microphone initialized in', this.metrics.micConnectMs, 'ms');

      // 2. Emit mic-started IMMEDIATELY so UI shows mic is active
      this._emit('state', { state: this.state, metrics: { ...this.metrics } });
      this._emit('mic-started', { deviceName: this._getMicName() });
      console.log('[VoiceService] mic-started event emitted');

      // 3. Start VAD (does not depend on STT)
      console.log('[VoiceService] Step 2: Starting VAD...');
      this._startVAD();

      // 4. Start audio streaming (feeds audio to STT when connected)
      console.log('[VoiceService] Step 3: Starting audio streaming...');
      this._startAudioStreaming();

      // 5. Initialize STT provider in BACKGROUND (non-blocking)
      // STT failure should NOT prevent mic/audio/VAD from working
      console.log('[VoiceService] Step 4: Initializing STT provider (background)...');
      this._initSTTProvider().then(() => {
        console.log('[VoiceService] STT provider initialized successfully');
      }).catch((e) => {
        console.error('[VoiceService] STT provider failed:', e.message);
        this._emit('error', {
          type: 'stt-init',
          message: e.message,
          userMessage: 'STT unavailable: ' + e.message + '. Voice detection still works.',
        });
      });

    } catch (e) {
      console.error('[VoiceService] Failed to start:', e);
      // Cleanup any partially initialized resources
      try { this._cleanup(); } catch (_) {}
      this._setState(VoiceState.ERROR);
      this._emit('error', {
        type: 'mic',
        message: e.message,
        name: e.name,
        userMessage: this._getUserErrorMessage(e),
      });
    }
  }
  async stop() {
    if (this.state === VoiceState.IDLE) return;

    // Flush any pending transcript/turn before stopping
    if (this._useFlux && this._transcriptManager) {
      this._transcriptManager.flush();
    }
    if (this._turnManager) {
      this._turnManager.forceFlush();
    }

    // Send any pending transcript (legacy mode)
    const pending = this._getPendingTranscript();
    if (pending && this.state !== VoiceState.ERROR) {
      this._emit('final-transcript', { transcript: pending, from: 'pending' });
    }

    this._cleanup();
    this._setState(VoiceState.IDLE);
    this._emit('state', { state: this.state, metrics: { ...this.metrics } });
    this._emit('mic-stopped');
  }

  async toggle() {
    if (this.state === VoiceState.IDLE) await this.start();
    else await this.stop();
  }

  // ── Microphone ──────────────────────────────────────────────────────────
  async _initMicrophone() {
    let stream;
    if (this.engineMode) {
      await this._initEngineCapture();
      return;
    }
    if (this.config.audioSource === 'mic') {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
          latency: { ideal: 0.01 },
        }
      };

      if (this.config.micDevice && this.config.micDevice !== 'default') {
        constraints.audio.deviceId = { exact: this.config.micDevice };
      }

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      const track = stream.getAudioTracks()[0];
      this._micName = track?.label || 'Unknown Microphone';

      this._onDeviceChange = async () => {
        if (this.state === VoiceState.IDLE) return;
        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioDevices = devices.filter(d => d.kind === 'audioinput');
          this._emit('devices-changed', { devices: audioDevices });
        } catch (e) {}
      };
      navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);

      this._onVisibilityChange = () => {
        if (this.state === VoiceState.IDLE) return;
        if (document.hidden) {
          if (this._vadCheckInterval) {
            clearInterval(this._vadCheckInterval);
            this._vadCheckInterval = null;
            this._vadPausedByVisibility = true;
          }
        } else if (this._vadPausedByVisibility) {
          this._vadPausedByVisibility = false;
          this._startVAD();
        }
      };
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    } else {
      const sources = await window.electronAPI.getAudioSources();
      if (!sources || sources.length === 0) {
        throw new Error('No audio sources available. Check audio device connections.');
      }
      let selectedSource = sources[0];
      if (this.config.audioSourceId) {
        selectedSource = sources.find(s => s.id === this.config.audioSourceId) || selectedSource;
      } else if (this.config.audioSourceName) {
        selectedSource = sources.find(s => s.name === this.config.audioSourceName) || selectedSource;
      }

      const constraints = {
        audio: {
          mandatory: {
            chromiumAudioSourceId: selectedSource.id
          }
        }
      };

      stream = await navigator.mediaDevices.getUserMedia(constraints);
      this._micName = selectedSource.name || 'Unknown Audio Source';
    }

    this.mediaStream = stream;

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive',
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this.config.micGain || 1.5;

    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;
    this.analyserNode.smoothingTimeConstant = 0.7;
    this.analyserNode.minDecibels = -90;
    this.analyserNode.maxDecibels = -10;

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.analyserNode);

    this._useWorklet = false;
    this._workletNode = null;
    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);
    this.processorNode.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      if (input && input.length > 0) {
        const int16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
          const s = Math.max(-1, Math.min(1, input[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this._onAudioData(int16.buffer);
      }
    };
    this.gainNode.connect(this.processorNode);
    // Connect to destination with zero gain to keep the audio graph alive
    // (ScriptProcessorNode needs to be connected for onaudioprocess to fire)
    this._outputGain = this.audioContext.createGain();
    this._outputGain.gain.value = 0;
    this.processorNode.connect(this._outputGain);
    this._outputGain.connect(this.audioContext.destination);
  }

  _getMicName() {
    return this._micName || (this.engineMode ? 'Windows Audio Engine' : 'Unknown Microphone');
  }

  // ── Windows Audio Engine (WASAPI loopback) capture ────────────────────
  // Audio is captured & processed in the Electron main process (DSP pipeline:
  // downmix, resample 48k→16k, high-pass, noise gate, VAD, enhancement).
  // The renderer receives 20 ms Int16 frames and feeds them straight to STT.
  async _initEngineCapture() {
    if (!window.electronAPI || !window.electronAPI.startAudioEngine) {
      throw new Error('Audio engine bridge not available in this window');
    }

    console.log('[VoiceService] Initializing Windows Audio Engine capture...');
    const { sources, defaultSource } = await window.electronAPI.getAudioEngineSources() || {};
    console.log('[VoiceService] Available audio sources:', sources?.length || 0);
    let source = defaultSource || { pid: null, name: 'System Output', kind: 'system' };

    if (this.config.audioSourceId) {
      const found = (sources || []).find(s => String(s.pid) === String(this.config.audioSourceId));
      if (found) source = found;
    } else if (this.config.engineProcessName) {
      const found = (sources || []).find(s => String(s.name || '').toLowerCase().includes(String(this.config.engineProcessName).toLowerCase()));
      if (found) source = found;
    }

    console.log('[VoiceService] Selected audio source:', source?.name || 'System Output');

    const sourceObj = source && source.type === 'process'
      ? { type: 'process', pid: source.pid }
      : { type: 'system' };

    console.log('[VoiceService] Starting audio engine with source:', sourceObj);
    const res = await window.electronAPI.startAudioEngine({
      source: sourceObj,
      vadThreshold: this.vadThreshold,
      noiseGate: this.config.noiseGate !== false,
    });

    if (!res || !res.ok) {
      const detail = (res && res.error) || 'Failed to start Windows Audio Engine capture';
      console.error('[VoiceService] Audio engine start failed:', detail);
      const err = new Error(detail);
      err.name = 'AudioEngineError';
      throw err;
    }

    console.log('[VoiceService] Audio engine started successfully:', res);
    this._micName = (source && source.name) || 'System Audio (WASAPI)';
    if (source && source.kind === 'system') this._micName = 'System Output (Windows Audio Engine)';

    this._engineLevel = 0;
    this._engineVad = false;
    this._engineFrames = 0;

    // AnalyserNode-compatible shim so the visualizer keeps working.
    this.analyserNode = new PcmAnalyser({ sampleRate: 16000 });

    console.log('[VoiceService] Setting up frame event listener...');
    const removeFrame = window.electronAPI.onAudioEngineFrame((frame) => {
      this._onEngineFrame(frame);
    });
    const removeEvent = window.electronAPI.onAudioEngineEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'error') {
        console.error('[VoiceService] Audio engine error:', evt.message);
        this._emit('error', { type: 'audio-engine', message: evt.message || 'Audio engine error' });
      }
    });
    this._engineRemoveFns = [removeFrame, removeEvent];
    console.log('[VoiceService] Audio engine capture initialized successfully');
  }

  _onEngineFrame(frame) {
    if (this.state === VoiceState.IDLE || this.state === VoiceState.ERROR) return;
    this._engineFrames = (this._engineFrames || 0) + 1;
    this._engineLevel = typeof frame.level === 'number' ? frame.level : this._engineLevel;
    this._engineVad = !!frame.vad;

    // Log first few frames for debugging
    if (this._engineFrames <= 3) {
      console.log(`[VoiceService] Engine frame #${this._engineFrames}: level=${this._engineLevel.toFixed(4)}, vad=${this._engineVad}, pcm=${frame.pcm?.byteLength || 0} bytes`);
    }

    if (this.analyserNode && typeof this.analyserNode.feed === 'function') {
      this.analyserNode.feed(frame.pcm);
    }

    if (this.sttProvider && this.sttProvider.isConnected && this.sttProvider.isConnected()) {
      this.metrics.chunkCount++;
      const int16 = frame.pcm instanceof ArrayBuffer ? new Int16Array(frame.pcm) : frame.pcm;
      if (ArrayBuffer.isView(int16)) {
        const exact = int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength);
        this.sttProvider.sendAudio(exact);
      } else if (int16 instanceof ArrayBuffer) {
        this.sttProvider.sendAudio(int16);
      }
    }
  }

  // â”€â”€â”€ STT Provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _initSTTProvider() {
    let providerConfig;

    if (this.sttType === 'auto') {
      providerConfig = detectBestProvider(this.config);
    } else {
      providerConfig = { type: this.sttType, config: this.config };
    }

    // Engine frames are 16 kHz mono — STT must be told the right rate.
    const sttConfig = this.engineMode
      ? { ...providerConfig.config, sampleRate: 16000, mimeType: 'audio/wav', container: 'wav' }
      : providerConfig.config;

    this.sttProvider = createProvider(providerConfig.type, sttConfig);

    // Check if using Deepgram Flux (streaming with server-side VAD)
    this._useFlux = providerConfig.type === 'deepgram';

    if (this._useFlux) {
      console.log('[VoiceService] Deepgram Flux mode — server-side VAD + EndOfTurn');
      this._initFluxPipeline();
    } else {
      console.log('[VoiceService] Legacy STT mode — local VAD drives finalization');
      this._initLegacySTT();
    }

    await this.sttProvider.connect();
  }

  // ── Deepgram Flux Pipeline ────────────────────────────────────────────
  // Uses TranscriptManager + TurnManager for real-time streaming.
  // Deepgram handles VAD and turn detection — no local silence wait.
  _initFluxPipeline() {
    // Create TranscriptManager: accumulates partials, emits turn-complete
    this._transcriptManager = new TranscriptManager({
      onPartial: (data) => {
        if (this.state === VoiceState.IDLE) return;

        // Update interim transcript for UI display
        this.interimTranscript = data.accumulated;

        if (!this.metrics.firstPartialMs && this._speechStartTime) {
          this.metrics.firstPartialMs = Date.now() - this._speechStartTime;
        }

        this._emit('partial-transcript', {
          transcript: data.transcript,
          accumulated: data.accumulated,
          confidence: data.confidence,
          turnIndex: data.turnIndex,
        });
      },

      onFinal: (data) => {
        if (this.state === VoiceState.IDLE) return;

        // Accumulate final transcript
        this.finalTranscript = data.accumulated;
        this.interimTranscript = '';

        const now = Date.now();
        this._latency.sttFinal = now; // T2
        const t_stt = this._latency.speechEnd ? now - this._latency.speechEnd : 0;
        console.log(`[VoiceService] T2 STT_FINAL t_stt=${t_stt}ms transcript="${data.transcript.substring(0, 60)}"`);

        if (!this.metrics.firstFinalMs && this._speechStartTime) {
          this.metrics.firstFinalMs = Date.now() - this._speechStartTime;
        }

        this._emit('final-transcript', {
          transcript: data.transcript,
          accumulated: data.accumulated,
          confidence: data.confidence,
        });
      },

      onTurnComplete: (data) => {
        // Deepgram EndOfTurn — send to TurnManager for AI query
        console.log(`[VoiceService] Turn complete: "${data.transcript.substring(0, 80)}"`);
        if (this._turnManager) {
          this._turnManager.handleTurnComplete(data);
        }
      },
    });

    // Create TurnManager: debounces turns, emits turn-ready for AI
    this._turnManager = new TurnManager({
      debounceMs: this.config.turnDebounceMs ?? 800,
      onTurnReady: (data) => {
        // Emit turn-ready — components-init.js will send this to AI
        const now = Date.now();
        this._latency.aiRequest = now; // T3
        console.log(`[VoiceService] T3 AI_REQUEST (Flux): "${data.transcript.substring(0, 60)}"`);

        this._emit('turn-ready', {
          transcript: data.transcript,
          turnIndex: data.turnIndex,
          history: data.history,
        });

        this._emit('final-transcript', {
          transcript: data.transcript,
          accumulated: data.transcript,
          from: 'flux-turn',
        });
      },
    });

    // Wire Deepgram events → TranscriptManager
    this.sttProvider.onPartialTranscript((data) => {
      if (this.state === VoiceState.IDLE) return;
      this._transcriptManager.handlePartial(data.transcript, data.confidence);
    });

    this.sttProvider.onFinalTranscript((data) => {
      if (this.state === VoiceState.IDLE) return;
      this._transcriptManager.handleFinal(data.transcript, data.confidence, data.words);
    });

    // Deepgram UtteranceEnd → TranscriptManager turn-complete
    this.sttProvider.on('utterance-end', (data) => {
      if (this.state === VoiceState.IDLE) return;
      this._transcriptManager.handleUtteranceEnd(data.lastWordEnd);
    });

    this._wireCommonSTTEvents();
  }

  // ── Legacy STT Pipeline (Whisper / Browser) ──────────────────────────
  // Local VAD drives finalization via sendClose().
  _initLegacySTT() {
    this.sttProvider.onPartialTranscript((data) => {
      if (this.state === VoiceState.IDLE) return;
      this.interimTranscript = data.transcript;

      if (!this.metrics.firstPartialMs && this._speechStartTime) {
        this.metrics.firstPartialMs = Date.now() - this._speechStartTime;
      }
      if (!this.metrics.speechToPartialMs && this._speechStartTime) {
        this.metrics.speechToPartialMs = Date.now() - this._speechStartTime;
      }

      this._emit('partial-transcript', { transcript: data.transcript, confidence: data.confidence });
    });

    this.sttProvider.onFinalTranscript((data) => {
      if (this.state === VoiceState.IDLE) return;
      this.finalTranscript += data.transcript + ' ';
      this.interimTranscript = '';

      const now = Date.now();
      this._latency.sttFinal = now; // T2
      const t_stt = this._latency.speechEnd ? now - this._latency.speechEnd : 0;
      console.log(`[VoiceService] T2 STT_FINAL t_stt=${t_stt}ms transcript="${data.transcript.substring(0, 60)}"`);

      if (!this.metrics.firstFinalMs && this._speechStartTime) {
        this.metrics.firstFinalMs = Date.now() - this._speechStartTime;
      }
      if (!this.metrics.speechToFinalMs && this._speechStartTime) {
        this.metrics.speechToFinalMs = Date.now() - this._speechStartTime;
      }

      this._emit('final-transcript', { transcript: data.transcript, confidence: data.confidence, accumulated: this.finalTranscript.trim() });
      this._scheduleAutoSend();
    });

    this._wireCommonSTTEvents();
  }

  // ── Common STT Events ────────────────────────────────────────────────
  _wireCommonSTTEvents() {
    this.sttProvider.onError((data) => {
      this._emit('error', { type: 'stt', message: data.message, code: data.code });
    });

    this.sttProvider.onConnected((data) => {
      this._emit('stt-connected', data);
    });

    this.sttProvider.onDisconnected((data) => {
      this._emit('stt-disconnected', data);
    });

    this.sttProvider.onLatency((data) => {
      if (data.stt) this.metrics.vadDetectionMs = data.stt;
      this._emit('latency', { ...this.metrics });
    });
  }

  async _reconnectSTT() {
    if (this.state === VoiceState.IDLE || this.state === VoiceState.ERROR) return;
    if (!this.sttProvider) return;
    try {
      await this.sttProvider.connect();
    } catch (e) {
      console.error('STT reconnect failed:', e.message);
    }
  }

  // â”€â”€â”€ Audio Streaming â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _startAudioStreaming() {
    if (this._useWorklet) {
      // AudioWorklet sends data via port.onmessage (handled in _initMicrophone)
      return;
    }

    // ScriptProcessorNode fallback
    if (!this.processorNode) return;

    this.processorNode.onaudioprocess = (event) => {
      if (this.state === VoiceState.IDLE) return;

      const inputData = event.inputBuffer.getChannelData(0);
      this.metrics.chunkCount++;

      if (this.sttProvider?.isConnected()) {
        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        this.sttProvider.sendAudio(int16Data.buffer);
      }
    };
  }

  _onAudioData(buffer) {
    if (this.state === VoiceState.IDLE) return;
    this.metrics.chunkCount++;
    if (this.sttProvider?.isConnected()) {
      this.sttProvider.sendAudio(buffer);
    }
  }

  // â”€â”€â”€ Voice Activity Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _startVAD() {
    if (this._vadCheckInterval) clearInterval(this._vadCheckInterval);

    this._vadCheckInterval = setInterval(() => {
      if (this.state === VoiceState.IDLE || this.state === VoiceState.ERROR) return;

      const level = this._getAudioLevel();
      this.metrics.inputLevel = level;
      this._vadLevel = level;

      const now = Date.now();

      if (level > this.vadThreshold) {
        // Speech detected
        if (!this._isSpeaking) {
          this._isSpeaking = true;
          this._speechStartTime = now;
          this._setState(VoiceState.SPEAKING);
          this._emit('speech-start', { level });
        }
        this._silenceStartTime = 0;
      } else {
        // Silence
        if (this._isSpeaking) {
          if (this._silenceStartTime === 0) {
            this._silenceStartTime = now;
          }

          const silenceDuration = now - this._silenceStartTime;
          const speechDuration = now - this._speechStartTime;

          if (silenceDuration >= this.vadSilenceMs && speechDuration >= this.vadMinSpeechMs) {
            // End of speech
            this._isSpeaking = false;
            this._latency.speechEnd = Date.now(); // T1
            this._latency._speechStart = this._speechStartTime;
            console.log(`[VoiceService] T1 SPEECH_END duration=${speechDuration}ms level=${level.toFixed(4)}`);
            this._speechStartTime = 0;
            this._silenceStartTime = 0;
            this._setState(VoiceState.LISTENING);
            this._emit('speech-end', { duration: speechDuration, level });

            // Legacy mode: send close to STT to flush final transcript
            // Flux mode: Deepgram handles turn detection via UtteranceEnd — don't interrupt
            if (!this._useFlux && this.sttProvider?.sendClose) {
              this.sttProvider.sendClose();
            }
          }
        }
      }
      // Debug: log audio level every 2 seconds in mic mode
      if (!this.engineMode) {
        this._vadLogCount = (this._vadLogCount || 0) + 1;
        if (this._vadLogCount % 40 === 1) {
          console.log('[VoiceService] VAD level=' + level.toFixed(4) + ' threshold=' + this.vadThreshold + ' speaking=' + this._isSpeaking + ' chunks=' + this.metrics.chunkCount);
        }
      }
    }, 50); // 20Hz check rate for responsive VAD
  }

  _getAudioLevel() {
    if (this.engineMode) return this._engineLevel || 0;
    if (!this.analyserNode) return 0;
    if (!this._levelDataArray) {
      this._levelDataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
    }
    this.analyserNode.getByteFrequencyData(this._levelDataArray);
    let sum = 0;
    for (let i = 0; i < this._levelDataArray.length; i++) sum += this._levelDataArray[i];
    return sum / this._levelDataArray.length / 255;
  }

  // â”€â”€â”€ Auto Send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _scheduleAutoSend() {
    if (this._autoSendTimer) clearTimeout(this._autoSendTimer);
    this._autoSendTimer = setTimeout(() => {
      const pending = this._getPendingTranscript();
      if (pending && pending.length > 2) {
        this._emit('transcript-ready', { transcript: pending, from: 'auto-send' });
        this.finalTranscript = '';
        this.interimTranscript = '';
        this._emit('transcript-cleared');
      }
    }, this._autoSendDelay);
  }

  _getPendingTranscript() {
    return (this.finalTranscript + ' ' + this.interimTranscript).trim();
  }

  // â”€â”€â”€ Visualizer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  attachVisualizer(canvas, options = {}) {
    this.visualizer = new AudioVisualizer(canvas, options);
    if (this.analyserNode) {
      this.visualizer.attach(this.analyserNode);
      this.visualizer.start();
    }
  }

  detachVisualizer() {
    if (this.visualizer) {
      this.visualizer.destroy();
      this.visualizer = null;
    }
  }

  // â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _setState(state) {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      this._emit('state-change', { from: prev, to: state });
      this._emit('state', { state, metrics: { ...this.metrics } });
    }
  }

  // â”€â”€â”€ Error Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _getUserErrorMessage(error) {
    if (this.engineMode) {
      const msg = String((error && error.message) || error || '');
      if (msg.toLowerCase().includes('audio engine')) return `Audio engine error: ${msg}`;
      return msg || 'Windows Audio Engine capture failed. No output device found?';
    }
    const errorMap = {
      'NotAllowedError': 'Microphone permission denied. Check Windows Settings > Privacy > Microphone.',
      'NotFoundError': 'No microphone found. Connect a headset or USB mic.',
      'NotReadableError': 'Microphone is busy. Close Zoom/Teams/Discord and try again.',
      'OverconstrainedError': 'Selected microphone not found. Check Settings.',
      'AbortError': 'Microphone request timed out.',
    };
    const name = error && error.name ? error.name : '';
    const message = error && error.message ? error.message : String(error || '');
    return errorMap[name] || message || 'Unknown microphone error';
  }

  // â”€â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _cleanup() {
    // Clear timers
    for (const t of this._timers) clearTimeout(t);
    for (const i of this._intervals) clearInterval(i);
    this._timers = [];
    this._intervals = [];

    if (this._autoSendTimer) { clearTimeout(this._autoSendTimer); this._autoSendTimer = null; }
    if (this._vadCheckInterval) { clearInterval(this._vadCheckInterval); this._vadCheckInterval = null; }

    // Stop Windows Audio Engine capture and unsubscribe from frame events.
    if (this.engineMode && window.electronAPI && window.electronAPI.stopAudioEngine) {
      try { window.electronAPI.stopAudioEngine(); } catch (e) {}
    }
    if (this._engineRemoveFns) {
      for (const fn of this._engineRemoveFns) {
        try { fn(); } catch (e) {}
      }
      this._engineRemoveFns = null;
    }
    this._engineLevel = 0;
    this._engineVad = false;

    // Disconnect STT
    if (this.sttProvider) {
      try { this.sttProvider.destroy(); } catch (e) {}
      this.sttProvider = null;
    }

    // Cleanup Transcript & Turn managers
    if (this._transcriptManager) {
      this._transcriptManager.reset();
      this._transcriptManager = null;
    }
    if (this._turnManager) {
      this._turnManager.reset();
      this._turnManager = null;
    }
    this._useFlux = false;

    // Stop audio nodes
    if (this._workletNode) {
      try { this._workletNode.disconnect(); } catch (e) {}
      this._workletNode = null;
    }
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try { this.processorNode.disconnect(); } catch (e) {}
    this.processorNode = null;
    this._outputGain = null;
    }
    if (this._outputGain) {
      try { this._outputGain.disconnect(); } catch (e) {}
      this._outputGain = null;
    }

    // Disconnect in graph order: source -> gain -> analyser/processor
    if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (e) {} this.sourceNode = null; }
    if (this.gainNode) { try { this.gainNode.disconnect(); } catch (e) {} this.gainNode = null; }
    if (this.analyserNode) { try { if (typeof this.analyserNode.disconnect === 'function') this.analyserNode.disconnect(); } catch (e) {} this.analyserNode = null; }

    // Stop media stream
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }

    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try { this.audioContext.close(); } catch (e) {}
      this.audioContext = null;
    }

    // Remove device change listener
    if (this._onDeviceChange) {
      navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
      this._onDeviceChange = null;
    }

    // Remove visibility change listener
    if (this._onVisibilityChange) {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
      this._onVisibilityChange = null;
    }

    // Stop visualizer
    this.detachVisualizer();

    // Reset VAD state
    this._isSpeaking = false;
    this._speechStartTime = 0;
    this._silenceStartTime = 0;
    this._vadLevel = 0;
    this._levelDataArray = null;
  }

  destroy() {
    this._cleanup();
    this._listeners.clear();
    this.state = VoiceState.IDLE;
    this._timers = [];
  }

  // â”€â”€â”€ Diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  
  // Latency Instrumentation
  markAIRequest() {
    const now = Date.now();
    this._latency.aiRequest = now; // T3
    const t_prepare = this._latency.sttFinal ? now - this._latency.sttFinal : 0;
    console.log('[VoiceService] T3 AI_REQUEST t_prepare=' + t_prepare + 'ms');
  }

  markAIFirstToken() {
    const now = Date.now();
    this._latency.aiFirstToken = now; // T4
    const t_ai = this._latency.aiRequest ? now - this._latency.aiRequest : 0;
    console.log('[VoiceService] T4 AI_FIRST_TOKEN t_ai=' + t_ai + 'ms');
  }

  markUIRender() {
    const now = Date.now();
    this._latency.uiRender = now; // T5
    const total = this._latency.speechEnd ? now - this._latency.speechEnd : 0;
    this._latency.totalMs = total;
    const entry = {
      t1_speechEnd: this._latency.speechEnd,
      t2_sttFinal: this._latency.sttFinal,
      t3_aiRequest: this._latency.aiRequest,
      t4_aiFirstToken: this._latency.aiFirstToken,
      t5_uiRender: now,
      t_stt: this._latency.speechEnd && this._latency.sttFinal ? this._latency.sttFinal - this._latency.speechEnd : 0,
      t_prepare: this._latency.sttFinal && this._latency.aiRequest ? this._latency.aiRequest - this._latency.sttFinal : 0,
      t_ai: this._latency.aiRequest && this._latency.aiFirstToken ? this._latency.aiFirstToken - this._latency.aiRequest : 0,
      t_ui: this._latency.aiFirstToken ? now - this._latency.aiFirstToken : 0,
      total,
      question: this._latency._lastQuestion || '',
    };
    this._latency.history.push(entry);
    if (this._latency.history.length > 50) this._latency.history.shift();
    console.log('[VoiceService] T5 UI_RENDER TOTAL=' + total + 'ms (T_STT=' + entry.t_stt + ' T_AI=' + entry.t_ai + ' T_UI=' + entry.t_ui + ')');
    this._emit('latency-measurement', entry);
  }

  setLastQuestion(q) {
    this._latency._lastQuestion = q;
  }

  getLatencyHistory() {
    return [...this._latency.history];
  }

  getDiagnostics() {
        return {
        state: this.state,
        metrics: { ...this.metrics },
        sttConnected: this.sttProvider?.isConnected() || false,
        sttType: this.sttType,
        micActive: !!this.mediaStream,
        micName: this._micName,
        inputLevel: this.metrics.inputLevel,
        vadThreshold: this.vadThreshold,
        isSpeaking: this._isSpeaking,
        finalTranscript: this.finalTranscript,
        interimTranscript: this.interimTranscript,
        audioBackend: this._useWorklet ? 'AudioWorklet' : (this.engineMode ? 'WASAPI Loopback' : 'ScriptProcessor'),
        audioSource: this.config.audioSource,
        audioSourceId: this.config.audioSourceId,
        audioSourceName: this.config.audioSourceName,
        engineMode: this.engineMode,
        engineLevel: this._engineLevel,
        engineVad: this._engineVad,
        engineFrames: this._engineFrames || 0,
        useFlux: this._useFlux,
        turnManager: this._turnManager?.getMetrics() || null,
        transcriptTurnCount: this._transcriptManager?.getTurnCount() || 0,
        latency: { ...this._latency, history: this._latency.history.slice(-10) },
    };
  }
}