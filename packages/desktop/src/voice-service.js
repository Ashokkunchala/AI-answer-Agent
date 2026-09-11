// Voice Service - Complete voice pipeline
// Microphone â†’ VAD â†’ Streaming STT â†’ Transcript â†’ AI
//
// States: IDLE | LISTENING | SPEAKING | PROCESSING | ERROR
// Manages mic stream, audio context, VAD, STT provider, and performance metrics.

import { createProvider, detectBestProvider } from './providers/index.js';
import { AudioVisualizer } from './audio-visualizer.js';

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
        audioSource: 'mic',
        audioSourceId: null,
        audioSourceName: null,
      }, config);
    this.state = VoiceState.IDLE;

    // Audio
    this.audioContext = null;
    this.mediaStream = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.processorNode = null;

    // STT
    this.sttProvider = null;
    this.sttType = config.sttType || 'auto';

    // VAD
    this.vadThreshold = config.vadThreshold || 0.015;
    this.vadSilenceMs = config.vadSilenceMs || 1200;
    this.vadMinSpeechMs = config.vadMinSpeechMs || 300;
    this._vadLevel = 0;
    this._speechStartTime = 0;
    this._silenceStartTime = 0;
    this._isSpeaking = false;
    this._vadCheckInterval = null;

    // Transcript
    this.finalTranscript = '';
    this.interimTranscript = '';
    this._autoSendDelay = config.autoSendDelay || 1500;
    this._autoSendTimer = null;

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

      // 1. Get microphone
      await this._initMicrophone();
      this.metrics.micConnectMs = Date.now() - startTime;

      // 2. Initialize STT provider
      const sttStart = Date.now();
      await this._initSTTProvider();
      this.metrics.sttConnectMs = Date.now() - sttStart;

      // 3. Start VAD
      this._startVAD();

      // 4. Start audio streaming to STT
      this._startAudioStreaming();

      this._emit('state', { state: this.state, metrics: { ...this.metrics } });
      this._emit('mic-started', { deviceName: this._getMicName() });

    } catch (e) {
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

    // Send any pending transcript
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
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
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
    this.processorNode.connect(this.audioContext.destination);
  }

  _getMicName() {
    return this._micName || 'Unknown Microphone';
  }

  // â”€â”€â”€ STT Provider â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async _initSTTProvider() {
    let providerConfig;

    if (this.sttType === 'auto') {
      providerConfig = detectBestProvider(this.config);
    } else {
      providerConfig = { type: this.sttType, config: this.config };
    }

    this.sttProvider = createProvider(providerConfig.type, providerConfig.config);

    // Wire up STT events
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

      if (!this.metrics.firstFinalMs && this._speechStartTime) {
        this.metrics.firstFinalMs = Date.now() - this._speechStartTime;
      }
      if (!this.metrics.speechToFinalMs && this._speechStartTime) {
        this.metrics.speechToFinalMs = Date.now() - this._speechStartTime;
      }

      this._emit('final-transcript', { transcript: data.transcript, confidence: data.confidence, accumulated: this.finalTranscript.trim() });
      this._scheduleAutoSend();
    });

    this.sttProvider.onError((data) => {
      this._emit('error', { type: 'stt', message: data.message, code: data.code });
    });

    this.sttProvider.onConnected((data) => {
      this._emit('stt-connected', data);
    });

    this.sttProvider.onDisconnected((data) => {
      this._emit('stt-disconnected', data);
      if (this.state !== VoiceState.IDLE && this.state !== VoiceState.ERROR) {
        // Auto-reconnect
        setTimeout(() => this._reconnectSTT(), 1000);
      }
    });

    this.sttProvider.onLatency((data) => {
      if (data.stt) this.metrics.vadDetectionMs = data.stt;
      this._emit('latency', { ...this.metrics });
    });

    await this.sttProvider.connect();
  }

  async _reconnectSTT() {
    if (this.state === VoiceState.IDLE || this.state === VoiceState.ERROR) return;
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
      if (this.state === VoiceState.IDLE || !this.sttProvider?.isConnected()) return;

      const inputData = event.inputBuffer.getChannelData(0);
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      this.sttProvider.sendAudio(int16Data.buffer);
    };
  }

  _onAudioData(buffer) {
    if (this.state === VoiceState.IDLE || !this.sttProvider?.isConnected()) return;
    this.metrics.chunkCount++;
    this.sttProvider.sendAudio(buffer);
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
          this.metrics.vadDetectionMs = now - this._speechStartTime;
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
            this._speechStartTime = 0;
            this._silenceStartTime = 0;
            this._emit('speech-end', { duration: speechDuration, level });

            // Send close to STT to flush final transcript
            if (this.sttProvider?.sendClose) {
              this.sttProvider.sendClose();
            }
          }
        }
      }
    }, 50); // 20Hz check rate for responsive VAD
  }

  _getAudioLevel() {
    if (!this.analyserNode) return 0;
    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.analyserNode.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
    return sum / dataArray.length / 255;
  }

  // â”€â”€â”€ Auto Send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _scheduleAutoSend() {
    if (this._autoSendTimer) clearTimeout(this._autoSendTimer);
    this._autoSendTimer = setTimeout(() => {
      const pending = this._getPendingTranscript();
      if (pending && pending.length > 2) {
        this._emit('final-transcript', { transcript: pending, from: 'auto-send' });
        this.finalTranscript = '';
        this.interimTranscript = '';
        this._emit('transcript-cleared');
      }
    }, this._autoSendDelay);
    this._timers.push(this._autoSendTimer);
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
      this.visualizer.stop();
      this.visualizer = null;
    }
  }

  // â”€â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _setState(state) {
    const prev = this.state;
    this.state = state;
    if (prev !== state) {
      this._emit('state-change', { from: prev, to: state });
    }
  }

  // â”€â”€â”€ Error Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  _getUserErrorMessage(error) {
    const errorMap = {
      'NotAllowedError': 'Microphone permission denied. Check Windows Settings > Privacy > Microphone.',
      'NotFoundError': 'No microphone found. Connect a headset or USB mic.',
      'NotReadableError': 'Microphone is busy. Close Zoom/Teams/Discord and try again.',
      'OverconstrainedError': 'Selected microphone not found. Check Settings.',
      'AbortError': 'Microphone request timed out.',
    };
    return errorMap[error.name] || error.message || 'Unknown microphone error';
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

    // Disconnect STT
    if (this.sttProvider) {
      try { this.sttProvider.destroy(); } catch (e) {}
      this.sttProvider = null;
    }

    // Stop audio nodes
    if (this._workletNode) {
      try { this._workletNode.disconnect(); } catch (e) {}
      this._workletNode = null;
    }
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      try { this.processorNode.disconnect(); } catch (e) {}
      this.processorNode = null;
    }

    if (this.analyserNode) { try { this.analyserNode.disconnect(); } catch (e) {} this.analyserNode = null; }
    if (this.gainNode) { try { this.gainNode.disconnect(); } catch (e) {} this.gainNode = null; }
    if (this.sourceNode) { try { this.sourceNode.disconnect(); } catch (e) {} this.sourceNode = null; }

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
  }

  destroy() {
    this._cleanup();
    this._listeners.clear();
    this.state = VoiceState.IDLE;
  }

  // â”€â”€â”€ Diagnostics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        audioBackend: this._useWorklet ? 'AudioWorklet' : 'ScriptProcessor',
        audioSource: this.config.audioSource,
        audioSourceId: this.config.audioSourceId,
        audioSourceName: this.config.audioSourceName,
    };
  }
}