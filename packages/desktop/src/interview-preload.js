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
  getAudioEngineSources: () => ipcRenderer.invoke('get-audio-engine-sources'),
  startAudioEngine: (opts) => ipcRenderer.invoke('start-audio-engine', opts),
  stopAudioEngine: () => ipcRenderer.invoke('stop-audio-engine'),
  getAudioEngineStatus: () => ipcRenderer.invoke('get-audio-engine-status'),
  onAudioEngineFrame: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('audio-engine-frame', listener);
    return () => ipcRenderer.removeListener('audio-engine-frame', listener);
  },
  onAudioEngineEvent: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('audio-engine-event', listener);
    return () => ipcRenderer.removeListener('audio-engine-event', listener);
  },

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

  // Voice Service (dedicated main-process engine; distinct channel names)
  voice: {
    getSources: () => ipcRenderer.invoke('voice:get-sources'),
    selectSource: (id) => ipcRenderer.invoke('voice:select-source', id),
    start: () => ipcRenderer.invoke('voice:start'),
    stop: () => ipcRenderer.invoke('voice:stop'),
    setListening: (enabled) => ipcRenderer.invoke('voice:set-listening', enabled),
    getDiagnostics: () => ipcRenderer.invoke('voice:get-diagnostics'),
    getLatency: () => ipcRenderer.invoke('voice:get-latency'),
    reportUiLatency: (ms) => ipcRenderer.invoke('voice:report-ui-latency', ms),
    sendMicFrame: (arrayBuffer) => ipcRenderer.send('voice:mic-frame', arrayBuffer),
    onState: (cb) => subscribe('voice:state', cb),
    onFrame: (cb) => subscribe('voice:frame', cb),
    onPartialTranscript: (cb) => subscribe('voice:partial-transcript', cb),
    onFinalTranscript: (cb) => subscribe('voice:final-transcript', cb),
    onClassified: (cb) => subscribe('voice:classified', cb),
    onAiStarted: (cb) => subscribe('voice:ai-started', cb),
    onAiToken: (cb) => subscribe('voice:ai-token', cb),
    onAiFirstToken: (cb) => subscribe('voice:ai-first-token', cb),
    onAiCompleted: (cb) => subscribe('voice:ai-completed', cb),
    onError: (cb) => subscribe('voice:error', cb),
    onLatency: (cb) => subscribe('voice:latency', cb),
    onSources: (cb) => subscribe('voice:sources', cb),
    onDevices: (cb) => subscribe('voice:devices', cb),
    onMicRequest: (cb) => subscribe('voice:mic-request', cb),
    onToggleHud: (cb) => subscribe('voice:hud-toggle', cb),
  },
});

function subscribe(channel, callback) {
  const listener = (event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
