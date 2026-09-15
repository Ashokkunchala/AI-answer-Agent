// STT Provider Registry
// Export all available providers

import { SpeechToTextProvider } from './base.js';
import { DeepgramProvider } from './deepgram.js';
import { BrowserProvider } from './browser.js';
import { WhisperProvider } from './whisper.js';

export { SpeechToTextProvider, DeepgramProvider, BrowserProvider, WhisperProvider };

// Provider factory
export function createProvider(type, config) {
  switch (type) {
    case 'deepgram':
      return new DeepgramProvider(config);
    case 'browser':
      return new BrowserProvider(config);
    case 'whisper':
      return new WhisperProvider(config);
    default:
      throw new Error(`Unknown STT provider: ${type}`);
  }
}

// Auto-detect best available provider
// Priority: Deepgram (WebSocket) > Whisper Worker (HTTP) > Browser (fallback)
export function detectBestProvider(config) {
  // Prefer Deepgram if API key is available (real WebSocket streaming)
  if (config.deepgramApiKey) {
    return { type: 'deepgram', config: { ...config, apiKey: config.deepgramApiKey } };
  }

  // Use Whisper via worker if worker URL is available
  if (config.workerUrl) {
    return { type: 'whisper', config };
  }

  // Fallback to browser (no API key needed, but limited)
  return { type: 'browser', config };
}
