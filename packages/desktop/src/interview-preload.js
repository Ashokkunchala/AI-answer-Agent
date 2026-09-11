// InterviewPanel Preload Bridge
// Exposes IPC API for the WishAI-style interview overlay

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('interviewAPI', {
  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),

  // Overlay control
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  openSettings: () => ipcRenderer.invoke('open-settings'),

  // AI
  queryAI: (data) => ipcRenderer.invoke('query-ai', data),

  // Screen
  manualCapture: () => ipcRenderer.invoke('manual-capture'),
  processCapture: (path) => ipcRenderer.invoke('process-capture', path),

  // History
  saveHistory: (data) => ipcRenderer.invoke('save-history', data),
  loadHistory: () => ipcRenderer.invoke('load-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  exportHistory: (data) => ipcRenderer.invoke('export-history', data),

  // Snippets
  saveSnippet: (data) => ipcRenderer.invoke('save-snippet', data),
  loadSnippets: () => ipcRenderer.invoke('load-snippets'),
  deleteSnippet: (data) => ipcRenderer.invoke('delete-snippet', data),

  // Profile
  uploadResume: (data) => ipcRenderer.invoke('upload-resume', data),
  uploadJobDesc: (data) => ipcRenderer.invoke('upload-job-desc', data),
  getResume: () => ipcRenderer.invoke('get-resume'),
  getJobDesc: () => ipcRenderer.invoke('get-job-desc'),

  // Audio
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  getAudioSources: () => ipcRenderer.invoke('get-audio-sources'),

  // Window
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'),
  startDrag: () => ipcRenderer.invoke('start-window-drag'),
  setPosition: (pos) => ipcRenderer.invoke('set-interview-position', pos),
  getPosition: () => ipcRenderer.invoke('get-interview-position'),

  // Events from main process
  onAnswerReady: (callback) => ipcRenderer.on('answer-ready', (event, data) => callback(data)),
  onAnswerStream: (callback) => ipcRenderer.on('answer-stream', (event, data) => callback(data)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, data) => callback(data)),
  onToggleMic: (callback) => ipcRenderer.on('toggle-mic', () => callback()),
  onScreenCaptured: (callback) => ipcRenderer.on('screen-captured', (event, path) => callback(path)),
});
