// Shared constants for the DevOps AI Agent Suite
// Used by both the worker and desktop packages

export const APP_NAME = 'DevOps AI Agent';
export const APP_VERSION = '4.0.0';

// Default worker URL (user should configure their own)
export const DEFAULT_WORKER_URL = '';

// API endpoints
export const API_ENDPOINTS = {
  CHAT: '/v1/chat/completions',
  ASK: '/ask',
  MODELS: '/v1/models',
  TASKS: '/v1/tasks',
  KEYS: '/v1/keys',
  REVOKE_KEY: '/v1/keys/revoke',
  USAGE: '/v1/usage',
  ROUTE: '/v1/route',
  HEALTH: '/health',
  DASHBOARD: '/dashboard',
  TRANSCRIBE: '/v1/audio/transcriptions',
};

// Default configuration for the desktop app
export const DEFAULT_CONFIG = {
  workerUrl: '',
  apiKey: '',
  model: 'auto',
  captureDelay: 500,
  hotkeyToggle: 'CommandOrControl+Shift+A',
  hotkeyCapture: 'CommandOrControl+Shift+C',
  overlayOpacity: 0.95,
  fontSize: 14,
  theme: 'dark',
  micDevice: 'default',
  micLanguage: 'en',
  micAutoSendDelay: 2000,
  micVadThreshold: 15,
  micGain: 1.5,
  ocrLanguage: 'eng',
  focusMode: 'all',
  participants: [],
  targetName: '',
  resume: '',
  jobDesc: '',
};

// Fast models for desktop app (optimized for <2s response)
export const FAST_MODELS = [
  { id: 'auto', name: 'Auto (smart routing)', tags: ['smart'] },
  { id: 'llama-3.2-3b', name: 'Llama 3.2 3B (fast)', tags: ['fast'] },
  { id: 'llama-3.2-1b', name: 'Llama 3.2 1B (fastest)', tags: ['fast'] },
  { id: 'llama-3.1-8b', name: 'Llama 3.1 8B', tags: ['fast'] },
];
