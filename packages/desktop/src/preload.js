// ═══════════════════════════════════════════════════════════════════════════
// STEALTH: Anti-Detection Overrides — runs BEFORE any page script
// These overrides defeat Electron/headless Chrome detection methods
// ═══════════════════════════════════════════════════════════════════════════

// 1. Override navigator.webdriver — headless/Electron detection
Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

// 2. Override navigator.plugins — Electron has 0, real Chrome has 3+
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const plugins = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, item: (i) => null, namedItem: (n) => null, [Symbol.iterator]: function*() {} },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1, item: (i) => null, namedItem: (n) => null, [Symbol.iterator]: function*() {} },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2, item: (i) => null, namedItem: (n) => null, [Symbol.iterator]: function*() {} },
    ];
    plugins.length = 3;
    return plugins;
  },
  configurable: true,
});

// 3. Override navigator.languages / navigator.language
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true });

// 4. Override navigator.connection.rtt — Electron returns 0, real browsers return 50-100
if (navigator.connection) {
  Object.defineProperty(navigator.connection, 'rtt', { get: () => 50, configurable: true });
}

// 5. Override navigator.hardwareConcurrency — return realistic value
Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });

// 6. Override navigator.deviceMemory — return realistic value
Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

// 7. Delete window.electron — Electron identifier
delete window.electron;

// 8. Delete window.require — Node.js identifier
delete window.require;

// 9. Override window.chrome — add runtime, loadTimes, csi methods
if (!window.chrome) window.chrome = {};
window.chrome.runtime = window.chrome.runtime || {
  connect: () => {},
  sendMessage: () => {},
};
window.chrome.loadTimes = () => ({
  requestTime: Date.now() / 1000 - 10,
  startLoadTime: Date.now() / 1000 - 9,
  firstPaintTime: Date.now() / 1000 - 8,
  firstPaintAfterLoadTime: 0,
  navigationType: 'Other',
  wasFetchedViaSpdy: true,
  wasNpnNegotiated: true,
  npnNegotiatedProtocol: 'h2',
  wasAlternateProtocolAvailable: false,
  connectionInfo: 'h2',
});
window.chrome.csi = () => ({
  onloadT: Date.now(),
  pageT: Date.now() - 10000,
  startE: Date.now() - 20000,
  tran: 15,
});

// 10. Override navigator.permissions.query
const _origQuery = navigator.permissions.query.bind(navigator.permissions);
navigator.permissions.query = (params) => {
  if (params.name === 'notifications') {
    return Promise.resolve({ state: typeof Notification !== 'undefined' ? (Notification.permission || 'default') : 'default' });
  }
  return _origQuery(params);
};

// 11. Override console.debug to prevent DevTools detection
const _origDebug = console.debug;
console.debug = function (...args) {
  if (args[0] && typeof args[0] === 'string' && args[0].includes('debugger')) return;
  return _origDebug.apply(console, args);
};

// 12. Override toString to prevent Function.toString detection of modified functions
const _nativeToString = Function.prototype.toString;
const _customFunctions = new Map();
Function.prototype.toString = function () {
  if (_customFunctions.has(this)) return _customFunctions.get(this);
  return _nativeToString.call(this);
};

// 13. Override window.outerWidth / outerHeight — Electron can differ from inner
Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth, configurable: true });
Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85, configurable: true });

// 14. Override screen.colorDepth — Electron sometimes returns 32
if (typeof screen !== 'undefined') {
  Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
}

// 15. Delete __dirname / __filename — Node.js artifacts in renderer
delete window.__dirname;
delete window.__filename;

// 16. Override navigator.mediaDevices.enumerateDevices — return realistic device list
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const _origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  navigator.mediaDevices.enumerateDevices = async () => {
    const devices = await _origEnumerate();
    return devices;
  };
}

// 17. Override toString for overridden navigator properties
const _navProps = ['webdriver', 'plugins', 'languages', 'language', 'hardwareConcurrency', 'deviceMemory'];
for (const prop of _navProps) {
  if (navigator[prop]) {
    _customFunctions.set(navigator[prop].bind ? navigator[prop].bind(navigator) : navigator[prop], `function get ${prop}() { [native code] }`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// IPC Bridge — exposed to renderer via contextBridge
// ═══════════════════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  toggleOverlay: () => ipcRenderer.invoke('toggle-overlay'),
  startScreenWatch: () => ipcRenderer.invoke('start-screen-watch'),
  stopScreenWatch: () => ipcRenderer.invoke('stop-screen-watch'),
  manualCapture: () => ipcRenderer.invoke('manual-capture'),
  processCapture: (path) => ipcRenderer.invoke('process-capture', path),
  queryAI: (data) => ipcRenderer.invoke('query-ai', data),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getScreenInfo: () => ipcRenderer.invoke('get-screen-info'),
  transcribeAudio: (data) => ipcRenderer.invoke('transcribe-audio', data),
  getAudioSources: () => ipcRenderer.invoke('get-audio-sources'),
  saveSnippet: (data) => ipcRenderer.invoke('save-snippet', data),
  loadSnippets: () => ipcRenderer.invoke('load-snippets'),
  deleteSnippet: (data) => ipcRenderer.invoke('delete-snippet', data),
  saveHistory: (data) => ipcRenderer.invoke('save-history', data),
  loadHistory: () => ipcRenderer.invoke('load-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  exportHistory: (data) => ipcRenderer.invoke('export-history', data),
  uploadResume: (data) => ipcRenderer.invoke('upload-resume', data),
  uploadJobDesc: (data) => ipcRenderer.invoke('upload-job-desc', data),
  getResume: () => ipcRenderer.invoke('get-resume'),
  getJobDesc: () => ipcRenderer.invoke('get-job-desc'),

  // ── Stealth APIs ──
  setOverlayOpacity: (opacity) => ipcRenderer.invoke('set-overlay-opacity', opacity),
  setWindowClickThrough: (enabled) => ipcRenderer.invoke('set-window-click-through', enabled),
  setWindowTitle: (title) => ipcRenderer.invoke('set-window-title', title),
  getStealthStatus: () => ipcRenderer.invoke('get-stealth-status'),

  onScreenCaptured: (callback) => ipcRenderer.on('screen-captured', (event, path) => callback(path)),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, status) => callback(status)),
  onAnswerReady: (callback) => ipcRenderer.on('answer-ready', (event, answer) => callback(answer)),
  onAnswerStream: (callback) => ipcRenderer.on('answer-stream', (event, data) => callback(data)),
  onToggleMic: (callback) => ipcRenderer.on('toggle-mic', (event) => callback(event)),
  onResumeUpdated: (callback) => ipcRenderer.on('resume-updated', (event) => callback(event)),
  onJobDescUpdated: (callback) => ipcRenderer.on('job-desc-updated', (event) => callback(event)),
  getWindowList: () => ipcRenderer.invoke('get-window-list'),
});
