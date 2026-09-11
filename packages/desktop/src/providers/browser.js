// Browser Web Speech API STT Provider (Fallback)
// Uses the browser's built-in speech recognition
// Works offline on some browsers (Chrome)

import { SpeechToTextProvider } from './base.js';

export class BrowserProvider extends SpeechToTextProvider {
  constructor(config = {}) {
    super(config);
    this.recognition = null;
    this._destroyed = false;
  }

  get language() { return this.config.language || 'en-US'; }

  async connect() {
    if (this._destroyed) throw new Error('Provider destroyed');

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('Web Speech API not supported in this browser/Electron build');
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = this.language;
    this.recognition.maxAlternatives = 1;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Speech recognition init timeout'));
      }, 5000);

      this.recognition.onstart = () => {
        clearTimeout(timeout);
        this.connected = true;
        this._emit('connected', { provider: 'browser' });
        resolve();
      };

      this.recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript || '';
          const confidence = result[0]?.confidence || 0;

          if (!transcript.trim()) continue;

          if (result.isFinal) {
            this._emit('final', {
              transcript: transcript.trim(),
              confidence,
              words: [],
              duration: 0,
            });
          } else {
            this._emit('partial', {
              transcript: transcript.trim(),
              confidence,
            });
          }
        }
      };

      this.recognition.onerror = (event) => {
        clearTimeout(timeout);
        const errorMap = {
          'not-allowed': 'Microphone permission denied',
          'service-not-allowed': 'Speech service not allowed',
          'no-speech': 'No speech detected',
          'audio-capture': 'Audio capture error',
          'network': 'Network error - check internet connection',
          'aborted': 'Speech recognition aborted',
          'service-not-available': 'Speech service unavailable - check internet',
        };
        const message = errorMap[event.error] || `Speech error: ${event.error}`;
        this._emit('error', { type: 'stt', message, code: event.error });
      };

      this.recognition.onend = () => {
        const wasConnected = this.connected;
        this.connected = false;
        this._emit('disconnected', { code: 0, reason: 'ended', wasConnected });
      };

      try {
        this.recognition.start();
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  async disconnect() {
    this._destroyed = true;
    if (this.recognition) {
      try {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        this.recognition.onresult = null;
        this.recognition.onstart = null;
        this.recognition.stop();
      } catch (e) {}
      this.recognition = null;
    }
    this.connected = false;
    this._emit('disconnected', { code: 1000, reason: 'Client disconnect', wasConnected: false });
  }

  async sendAudio(audioData) {
    // Browser STT manages its own audio stream - sendAudio is not used
    return false;
  }

  destroy() {
    this._destroyed = true;
    this.disconnect();
    this.listeners.clear();
  }
}
