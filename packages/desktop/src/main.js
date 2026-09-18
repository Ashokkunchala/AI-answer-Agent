const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const OCREngine = require('./ocr-engine');
const { AudioSourceManager, WindowsAudioCapture } = require('./audio/windows-audio-capture');

// ── Process Identity Obfuscation ──────────────────────────────────────────
// Change process title so Task Manager / wmic shows a generic name
process.title = 'Runtime Broker';

// Spoof process.argv to remove Electron-specific flags visible in wmic
if (process.argv.length > 1) {
  const realArgv = process.argv.slice();
  process.argv.length = 1;
  process.argv[0] = 'C:\\Windows\\System32\\RuntimeBroker.exe';
}

// Spoof process.execPath — Task Manager reads this from PEB
Object.defineProperty(process, 'execPath', {
  get: () => 'C:\\Windows\\System32\\RuntimeBroker.exe',
  configurable: false,
});

// Hide Electron-specific process properties visible in renderer
Object.defineProperty(process, 'type', { get: () => 'browser', configurable: false });

// Remove Electron-specific env vars that could be detected
delete process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_NO_ASAR;

// ── Chromium Stealth Flags ────────────────────────────────────────────────
// Audio permissions: disable sandbox so getUserMedia works reliably
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');

// Anti-detection: disable DevTools detection, remote debugging, and tracing
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('no-default-browser-check');

// Disable remote debugging port (prevents attach-based detection)
app.commandLine.appendSwitch('remote-debugging-port', '0');

// DPI awareness for correct anti-capture behavior on high-DPI displays
app.commandLine.appendSwitch('force-device-scale-factor', '1');

// Hide the console window on Windows (if spawned via cmd)
try {
  const user32 = require('koffi').load('user32.dll');
  const GetConsoleWindow = user32.func('GetConsoleWindow', 'int64', []);
  const ShowWindow = user32.func('ShowWindow', 'bool', ['int64', 'int']);
  const hwnd = GetConsoleWindow();
  if (hwnd) ShowWindow(hwnd, 0); // SW_HIDE
} catch (e) { /* koffi not available */ }

let logPath = null;
function log(...args) {
  try {
    if (!logPath) {
      fs.mkdirSync(path.join(app.getPath('userData'), 'logs'), { recursive: true });
      logPath = path.join(app.getPath('userData'), 'logs', 'app.log');
    }
    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`);
  } catch (e) { /* logging should never crash */ }
}
function safeStringify(o) {
  try { return JSON.stringify(o); } catch (e) { return String(o); }
}

let koffiLib = null;
let fnSetWindowDisplayAffinity = null;
let fnSetWindowLongW = null;
let fnGetWindowLongW = null;
let fnSetLayeredWindowAttributes = null;
let fnFindWindowW = null;
let fnSetWindowTextW = null;
let antiCaptureScriptWritten = false;

try {
  const koffi = require('koffi');
  koffiLib = koffi.load('user32.dll');
  fnSetWindowDisplayAffinity = koffiLib.func('SetWindowDisplayAffinity', 'bool', ['int64', 'uint32']);
  // Window style manipulation (for click-through, layered windows)
  fnSetWindowLongW = koffiLib.func('SetWindowLongW', 'int32', ['int64', 'int', 'int32']);
  fnGetWindowLongW = koffiLib.func('GetWindowLongW', 'int32', ['int64', 'int']);
  // Layered window attributes (transparency, click-through)
  fnSetLayeredWindowAttributes = koffiLib.func('SetLayeredWindowAttributes', 'bool', ['int64', 'uint32', 'uint8', 'int32']);
  // Find and rename windows
  fnFindWindowW = koffiLib.func('FindWindowW', 'int64', ['void*', 'void*']);
  fnSetWindowTextW = koffiLib.func('SetWindowTextW', 'bool', ['int64', 'void*']);
} catch (e) {
  console.log('koffi not available:', e.message);
}

let mainWindow;
let settingsWindow;
let interviewPanel;
let tray;
let isOverlayVisible = true;
let isScreenWatching = false;
let watchInterval;
let ocrEngine = null;
let lastScreenText = '';
let isInterviewVisible = false;

const USER_DATA_PATH = app.getPath('userData');
const CONFIG_PATH = path.join(USER_DATA_PATH, 'config.json');
const ANTI_CAPTURE_SCRIPT = path.join(USER_DATA_PATH, 'anti_capture.ps1');

// Centralized default worker URL (empty = user must configure)
const DEFAULT_WORKER_URL = 'https://devops-ai-agent.ashokkunchla.workers.dev';

const DEFAULT_CONFIG = {
  workerUrl: DEFAULT_WORKER_URL,
  apiKey: '',
  model: 'auto',
  captureDelay: 500,
  hotkeyToggle: 'CommandOrControl+Shift+A',
  hotkeyCapture: 'CommandOrControl+Shift+C',
  hotkeyPanicHide: 'CommandOrControl+H',
  hotkeyToggleAudio: 'CommandOrControl+L',
  hotkeySilentCapture: 'CommandOrControl+J',
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
  deepgramApiKey: '',
  sttType: 'auto',
  eotThreshold: 0.5,
  eotTimeoutMs: 1500,
  eagerEotThreshold: 0.5,
  probeModelOnStart: true,
  interviewX: null,
  interviewY: null,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        // Corrupted JSON — backup the corrupt file and fall back to defaults
        try {
          const backupPath = CONFIG_PATH + '.corrupt.' + Date.now();
          fs.copyFileSync(CONFIG_PATH, backupPath);
          log('[Config] Corrupted config.json backed up to ' + backupPath + ', falling back to defaults');
        } catch (_) { /* best effort */ }
        return { ...DEFAULT_CONFIG };
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        log('[Config] config.json is not an object, falling back to defaults');
        return { ...DEFAULT_CONFIG };
      }

      // Validate critical fields
      if (parsed.workerUrl !== undefined && typeof parsed.workerUrl !== 'string') {
        log('[Config] Invalid workerUrl type, using default');
        parsed.workerUrl = DEFAULT_WORKER_URL;
      }
      if (parsed.deepgramApiKey !== undefined && typeof parsed.deepgramApiKey !== 'string') {
        log('[Config] Invalid deepgramApiKey type, clearing');
        parsed.deepgramApiKey = '';
      }

      // Ensure workerUrl is never empty or localhost-only (prevent ECONNREFUSED)
      if (!parsed.workerUrl || parsed.workerUrl.trim() === '') {
        parsed.workerUrl = DEFAULT_WORKER_URL;
      }

      // Deepgram key via environment when not set in config.json – the voice
      // pipeline NEVER exposes the key to the renderer.
      if (!parsed.deepgramApiKey && process.env.DEEPGRAM_API_KEY) {
        parsed.deepgramApiKey = process.env.DEEPGRAM_API_KEY;
      }

      // Load resume from file if exists
      try {
        const resumePath = path.join(app.getPath('userData'), 'resume.txt');
        if (fs.existsSync(resumePath)) {
          parsed.resume = fs.readFileSync(resumePath, 'utf8');
        }
      } catch (e) { /* ignore */ }

      // Load job description from file if exists
      try {
        const jobDescPath = path.join(app.getPath('userData'), 'job_desc.txt');
        if (fs.existsSync(jobDescPath)) {
          parsed.jobDesc = fs.readFileSync(jobDescPath, 'utf8');
        }
      } catch (e) { /* ignore */ }

      return parsed;
    }
  } catch (e) {
    log('[Config] loadConfig error: ' + e.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  try {
    // Backup existing config before overwriting
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const backupPath = CONFIG_PATH + '.bak';
        fs.copyFileSync(CONFIG_PATH, backupPath);
      } catch (_) { /* best effort */ }
    }
    // Atomic write: write to temp file then rename (atomic on NTFS)
    const tmpPath = CONFIG_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (e) {
    log('[Config] saveConfig error: ' + e.message);
    // Fallback: direct write if rename fails
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch (_) { /* give up */ }
  }
}

const config = loadConfig();

// Write anti-capture PowerShell script only once
function writeAntiCaptureScript() {
  if (antiCaptureScriptWritten) return;

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Display {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
}
"@

$hwndVal = [IntPtr]$args[0]
$affinity = [uint32]0x00000011
$result = [Win32Display]::SetWindowDisplayAffinity($hwndVal, $affinity)
Write-Output $result
`;
  fs.writeFileSync(ANTI_CAPTURE_SCRIPT, script);
  antiCaptureScriptWritten = true;
}

function applyAntiCapture(win) {
  if (!win || win.isDestroyed()) return false;

  const hwndBuf = win.getNativeWindowHandle();
  let handleValue;

  if (Buffer.isBuffer(hwndBuf)) {
    if (hwndBuf.length >= 8) {
      handleValue = hwndBuf.readBigUInt64LE(0);
    } else {
      handleValue = hwndBuf.readUInt32LE(0);
    }
  } else {
    handleValue = Number(hwndBuf);
  }

  // Method 1: koffi direct call (most reliable, no PowerShell)
  if (fnSetWindowDisplayAffinity) {
    try {
      // Try WDA_EXCLUDEFROMCAPTURE first — window is INVISIBLE in captures (not black)
      const result1 = fnSetWindowDisplayAffinity(handleValue, 0x00000011); // WDA_EXCLUDEFROMCAPTURE
      if (result1) {
        log('[Stealth] SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE applied');
        return true;
      }

      // Fallback to WDA_MONITOR — window appears BLACK in captures
      const result2 = fnSetWindowDisplayAffinity(handleValue, 0x00000001); // WDA_MONITOR
      if (result2) {
        log('[Stealth] SetWindowDisplayAffinity WDA_MONITOR applied (fallback)');
        return true;
      }
    } catch (e) {
      log('[Stealth] koffi method failed: ' + e.message);
    }
  }

  // Method 2: PowerShell script file fallback
  try {
    writeAntiCaptureScript();

    const result = execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ANTI_CAPTURE_SCRIPT}" ${handleValue}`,
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const output = result.trim();
    if (output === 'True') return true;
  } catch (e) {
    console.log('PowerShell method failed:', e.message);
  }

  console.log('All anti-capture methods failed. Window will be visible to screen capture.');
  return false;
}

function applyAntiCaptureWithRetry(win) {
  if (!win || win.isDestroyed()) return;
  let attempts = 0;
  const maxAttempts = 5;
  const tryApply = () => {
    if (!win || win.isDestroyed()) return;
    const ok = applyAntiCapture(win);
    if (!ok && attempts < maxAttempts) {
      attempts++;
      setTimeout(tryApply, 500);
    }
  };
  tryApply();
}

// ── Window Stealth: click-through, layered transparency, title obfuscation ──
const GWL_EXSTYLE = -20;
const WS_EX_LAYERED = 0x00080000;
const WS_EX_TRANSPARENT = 0x00000020;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const LWA_ALPHA = 0x00000002;

// Generic decoy window titles to rotate through
const DECOY_TITLES = [
  'Microsoft Text Input Application',
  'Settings',
  'Program Manager',
  'Windows Security',
  'Network Status',
  'Sound',
  'Cortana',
];

function applyWindowStealth(win, options = {}) {
  if (!win || win.isDestroyed()) return false;

  const hwndBuf = win.getNativeWindowHandle();
  let handleValue;
  if (Buffer.isBuffer(hwndBuf)) {
    handleValue = hwndBuf.length >= 8
      ? hwndBuf.readBigUInt64LE(0)
      : hwndBuf.readUInt32LE(0);
  } else {
    handleValue = Number(hwndBuf);
  }

  // 1. Set extended window style: ToolWindow (hidden from Alt+Tab).
  // NOTE: WS_EX_NOACTIVATE is deliberately NOT applied. It prevents the
  // window from ever becoming active, which blocks keyboard input to the
  // question/input text boxes (typing did nothing).
  if (fnGetWindowLongW && fnSetWindowLongW) {
    try {
      const exStyle = fnGetWindowLongW(handleValue, GWL_EXSTYLE);
      const newStyle = exStyle | WS_EX_TOOLWINDOW;
      fnSetWindowLongW(handleValue, GWL_EXSTYLE, newStyle);
    } catch (e) { /* best effort */ }
  }

  // 2. Set a decoy window title
  if (fnSetWindowTextW) {
    try {
      const title = options.title || DECOY_TITLES[Math.floor(Math.random() * DECOY_TITLES.length)];
      // Encode title as null-terminated UTF-16LE for SetWindowTextW
      const titleWithNull = title + '\0';
      const utf16le = [];
      for (let i = 0; i < titleWithNull.length; i++) {
        const code = titleWithNull.charCodeAt(i);
        utf16le.push(code & 0xff);        // Low byte
        utf16le.push((code >> 8) & 0xff); // High byte
      }
      const buf = Buffer.from(utf16le);
      fnSetWindowTextW(handleValue, buf);
    } catch (e) { /* best effort */ }
  }

  // 3. Set window opacity (if requested)
  if (options.opacity !== undefined && fnSetLayeredWindowAttributes) {
    try {
      const exStyle = fnGetWindowLongW ? fnGetWindowLongW(handleValue, GWL_EXSTYLE) : 0;
      if (fnSetWindowLongW) {
        fnSetWindowLongW(handleValue, GWL_EXSTYLE, exStyle | WS_EX_LAYERED);
      }
      fnSetLayeredWindowAttributes(handleValue, 0, Math.round(options.opacity * 255), LWA_ALPHA);
    } catch (e) { /* best effort */ }
  }

  return true;
}

// ── Combined Stealth Mode ──
// Uses Electron's setContentProtection (reliable, no rendering issues)
// plus window stealth (title rotation, hidden from Alt+Tab)
function applyStealthMode(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
    log('[Stealth] setContentProtection enabled — window hidden from screen capture');
  } catch (e) {
    log('[Stealth] setContentProtection failed: ' + e.message);
  }
  applyWindowStealth(win);
}

// Randomize window title on an interval to avoid pattern detection
let titleRotationInterval = null;
function startTitleRotation(win, intervalMs = 30000) {
  stopTitleRotation();
  if (!win || win.isDestroyed() || !fnSetWindowTextW) return;

  const rotate = () => {
    if (!win || win.isDestroyed()) { stopTitleRotation(); return; }
    const hwndBuf = win.getNativeWindowHandle();
    let hv;
    if (Buffer.isBuffer(hwndBuf)) {
      hv = hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0) : hwndBuf.readUInt32LE(0);
    } else { hv = Number(hwndBuf); }
    const title = DECOY_TITLES[Math.floor(Math.random() * DECOY_TITLES.length)];
    try {
      // Encode title as null-terminated UTF-16LE for SetWindowTextW
      const titleWithNull = title + '\0';
      const utf16le = [];
      for (let i = 0; i < titleWithNull.length; i++) {
        const code = titleWithNull.charCodeAt(i);
        utf16le.push(code & 0xff);        // Low byte
        utf16le.push((code >> 8) & 0xff); // High byte
      }
      const buf = Buffer.from(utf16le);
      fnSetWindowTextW(hv, buf);
    } catch (e) {}
  };

  rotate();
  titleRotationInterval = setInterval(rotate, intervalMs);
}

function stopTitleRotation() {
  if (titleRotationInterval) { clearInterval(titleRotationInterval); titleRotationInterval = null; }
}

// ── Periodic Stealth Re-application ────────────────────────────────────────
// Known Electron bug: SetWindowDisplayAffinity resets when window is hidden/shown.
// Re-apply every 3 seconds to maintain protection through toggles.
let stealthReapplyInterval = null;
function startStealthReapply() {
  stopStealthReapply();
  stealthReapplyInterval = setInterval(() => {
    const wins = [mainWindow, settingsWindow, interviewPanel];
    for (const win of wins) {
      if (win && !win.isDestroyed() && win.isVisible()) {
        try { applyAntiCapture(win); } catch (e) { /* best effort */ }
      }
    }
  }, 3000);
}
function stopStealthReapply() {
  if (stealthReapplyInterval) { clearInterval(stealthReapplyInterval); stealthReapplyInterval = null; }
}

// ── Overlay opacity control ──
function setOverlayOpacity(win, opacity) {
  if (!win || win.isDestroyed()) return;
  // Clamp between 0.05 and 1.0
  const clamped = Math.max(0.05, Math.min(1.0, opacity));
  win.setOpacity(clamped);
}

function createMainWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  log(`[Main] Screen dimensions: ${screenWidth}x${screenHeight}`);

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    x: 100,
    y: 100,
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    popup: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  log(`[Main] Window created with initial bounds: ${mainWindow.getBounds()}`);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.once('ready-to-show', () => {
    log('[Main] Window ready to show');
    const bounds = mainWindow.getBounds();
    log(`[Main] Window bounds at ready-to-show: ${JSON.stringify(bounds)}`);

    // CRITICAL: Apply anti-capture BEFORE window becomes visible
    // SetWindowDisplayAffinity must be set before the first frame is composited
    applyAntiCaptureWithRetry(mainWindow);
    applyWindowStealth(mainWindow);
    startTitleRotation(mainWindow);
    if (config.overlayOpacity) setOverlayOpacity(mainWindow, config.overlayOpacity);

    // NOW show the window — anti-capture is already applied
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.setIgnoreMouseEvents(false);
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.show(); settingsWindow.focus(); return; }

  const d = screen.getPrimaryDisplay().workArea;
  const bw = 540;
  const bh = 720;
  let x = d.x + Math.floor(d.width / 2) - bw - 12;
  let y = d.y + Math.floor((d.height - bh) / 2);
  if (x < d.x) x = d.x;

  settingsWindow = new BrowserWindow({
    width: bw,
    height: bh,
    x,
    y,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a14',
    popup: true,
    alwaysOnTop: true,
    parent: mainWindow || undefined,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
    applyAntiCaptureWithRetry(settingsWindow);
    applyWindowStealth(settingsWindow, { title: 'Settings' });
  });
  settingsWindow.on('show', () => applyAntiCaptureWithRetry(settingsWindow));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createInterviewPanelWindow() {
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    interviewPanel.show();
    interviewPanel.focus();
    return;
  }

  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const pw = 380;
  const ph = screenHeight - 60;
  const px = screenWidth - pw;
  const py = 30;

  interviewPanel = new BrowserWindow({
    width: pw,
    height: ph,
    x: px,
    y: py,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    popup: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'interview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  interviewPanel.loadFile(path.join(__dirname, '..', 'renderer', 'interview.html'));
  interviewPanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  interviewPanel.once('ready-to-show', () => {
    interviewPanel.show();
    interviewPanel.focus();
    isInterviewVisible = true;
    applyAntiCaptureWithRetry(interviewPanel);
    applyWindowStealth(interviewPanel, { title: 'Program Manager' });
  });

  interviewPanel.on('show', () => {
    isInterviewVisible = true;
    applyAntiCaptureWithRetry(interviewPanel);
  });

  interviewPanel.on('closed', () => {
    interviewPanel = null;
    isInterviewVisible = false;
  });

  let _moveDebounce = null;
  interviewPanel.on('move', () => {
    // Debounce: save position at most once per 500ms during drag
    if (_moveDebounce) clearTimeout(_moveDebounce);
    _moveDebounce = setTimeout(() => {
      try {
        const pos = interviewPanel.getPosition();
        config.interviewX = pos[0];
        config.interviewY = pos[1];
        saveConfig(config);
      } catch (e) { /* ignore */ }
    }, 500);
  });
}

function toggleInterviewPanel() {
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    if (interviewPanel.isVisible()) {
      interviewPanel.hide();
      isInterviewVisible = false;
    } else {
      interviewPanel.show();
      interviewPanel.focus();
      isInterviewVisible = true;
    }
  } else {
    createInterviewPanelWindow();
  }
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('DevOps AI Answer Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide Overlay', click: () => toggleOverlay() },
    { label: 'Interview Panel', click: () => toggleInterviewPanel() },
    { label: 'Start Screen Watch', click: () => startScreenWatch() },
    { label: 'Stop Screen Watch', click: () => stopScreenWatch() },
    { type: 'separator' },
    { label: 'Settings', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('double-click', () => toggleOverlay());
}

let lastOverlayToggle = 0;
function toggleOverlay() {
  if (!mainWindow) return false;
  const now = Date.now();
  if (now - lastOverlayToggle < 300) return isOverlayVisible;
  lastOverlayToggle = now;
  isOverlayVisible = !isOverlayVisible;
  if (isOverlayVisible) {
    mainWindow.show();
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    // Re-apply anti-capture after show (Electron bug: affinity resets on hide/show)
    applyAntiCaptureWithRetry(mainWindow);
    applyWindowStealth(mainWindow);
    startTitleRotation(mainWindow);
    mainWindow.focus();
  } else {
    stopTitleRotation();
    mainWindow.hide();
  }
  return isOverlayVisible;
}

// OCR Engine with language change detection
let lastOCRLanguage = null;
async function initializeOCREngine() {
  const currentLang = config.ocrLanguage || 'eng';
  if (ocrEngine && lastOCRLanguage === currentLang) {
    return ocrEngine;
  }
  // Language changed or first init - recreate engine
  if (ocrEngine) {
    await ocrEngine.terminate();
    ocrEngine = null;
  }
  ocrEngine = new OCREngine(currentLang);
  await ocrEngine.init();
  lastOCRLanguage = currentLang;
  return ocrEngine;
}

async function captureScreen() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });
    if (sources.length > 0) {
      const pngData = sources[0].thumbnail.toPNG();
      const capturePath = path.join(USER_DATA_PATH, 'capture.png');
      fs.writeFileSync(capturePath, pngData);
      return capturePath;
    }
  } catch (e) {
    console.error('Screen capture failed:', e);
  }
  return null;
}

async function processScreenCapture(capturePath) {
  try {
    const engine = await initializeOCREngine();

    if (!engine.ready) {
      console.log('OCR not ready, skipping');
      return;
    }

    const result = await engine.extractText(capturePath);
    if (!result || !result.text) return;

    if (result.text === lastScreenText) return;
    lastScreenText = result.text;

    const detected = engine.detectQuestion(result.text);
    if (detected && mainWindow && !mainWindow.isDestroyed()) {
      const aiPrompt = engine.formatForAI(detected);
      if (aiPrompt) {
        // Send detected question to overlay
        mainWindow.webContents.send('answer-ready', {
          type: 'ocr',
          text: detected.question.substring(0, 500),
          confidence: result.confidence
        });

        // Stream AI answer (consistent with voice pipeline)
        try {
          const targets = [];
          if (interviewPanel && !interviewPanel.isDestroyed()) targets.push(interviewPanel);
          if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow);

          const onDelta = (full) => {
            for (const w of targets) {
              try { w.webContents.send('answer-stream', { type: 'answer', answer: full }); } catch (_) {}
            }
          };

          const answer = await queryAI(aiPrompt, onDelta);
          for (const w of targets) {
            try {
              w.webContents.send('answer-ready', {
                type: 'answer',
                question: detected.question.substring(0, 200),
                answer: answer.answer,
                provider: 'DevOps AI Agent',
                model: config.model,
                latency_ms: answer.latency_ms
              });
            } catch (_) {}
          }
        } catch (e) {
          console.error('AI query failed:', e.message);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer-ready', {
              type: 'answer',
              question: detected.question.substring(0, 200),
              answer: 'AI Error: ' + e.message
            });
          }
        }
      }
    }
  } catch (e) {
    console.error('processScreenCapture error:', e.message);
  }
}

function startScreenWatch() {
  if (isScreenWatching) return;
  isScreenWatching = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', { watching: true });
  }

  watchInterval = setInterval(async () => {
    if (!isScreenWatching) return;
    try {
      const capturePath = await captureScreen();
      if (capturePath) {
        await processScreenCapture(capturePath);
      }
    } catch (e) {
      console.error('Screen watch cycle error:', e.message);
    }
  }, config.captureDelay || 500);
}

function stopScreenWatch() {
  isScreenWatching = false;
  if (watchInterval) { clearInterval(watchInterval); watchInterval = null; }
  if (mainWindow) mainWindow.webContents.send('status-update', { watching: false });
}

// AI connector - uses shared fetch utility pattern
function parseSSE(body, onDelta) {
  return new Promise((resolve, reject) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    (function pump() {
      reader.read().then(({ done, value }) => {
        if (done) {
          if (buf.trim()) consumeLine(buf.trim());
          resolve(full);
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) {
            try { consumeLine(line); } catch (e) { reject(e); return; }
          }
        }
        pump();
      }).catch(reject);
    })();

    function consumeLine(line) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onDelta) onDelta(full, delta);
        }
      } catch (parseErr) {
        // Malformed JSON in SSE stream — skip this line, don't crash
      }
    }
  });
}

// Streaming request with API key 403 fallback
async function streamRequest(base, payload) {
  const mk = (withKey) => {
    const headers = { 'Content-Type': 'application/json' };
    if (withKey && config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;
    return headers;
  };
  let r = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: mk(true), body: JSON.stringify(payload)
  });
  if (r.status === 403 && config.apiKey) {
    r = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: mk(false), body: JSON.stringify(payload)
    });
    if (r.ok) { config.apiKey = ''; saveConfig(config); }
  }
  return r;
}

// AI connector - uses worker routing (model selection, system prompts, fallback chains all handled server-side)
async function queryAI(prompt, onDelta, history, taskType) {
  // Build list of worker URLs to try (configured first, then remote fallback)
  const configuredUrl = (config.workerUrl || '').replace(/\/+$/, '');
  const urls = [];
  if (configuredUrl && configuredUrl !== DEFAULT_WORKER_URL) {
    urls.push(configuredUrl);
  }
  urls.push(DEFAULT_WORKER_URL);

  // Build messages - worker handles system prompt injection
  const messages = [];
  if (Array.isArray(history) && history.length) {
    for (const turn of history.slice(0, 12)) {
      if (turn && turn.role && turn.content) messages.push({ role: turn.role, content: String(turn.content) });
    }
  }
  messages.push({ role: 'user', content: prompt });

  // Let worker handle: routing, system prompts, model fallback, context injection
  const payload = {
    model: 'auto',
    messages,
    max_tokens: 300,
    temperature: 0.1,
    stream: true,
    // Pass context for worker to inject into system prompt
    resume: config.resume || undefined,
    jobDesc: config.jobDesc || undefined,
    targetName: config.targetName || undefined,
    participants: config.participants?.length ? config.participants : undefined
  };

  // Include task type if provided (from mode selector)
  if (taskType && taskType !== 'auto') {
    payload.task_type = taskType;
  }

  const startTime = Date.now();
  let lastError = null;

  // Try each URL in sequence until one works
  for (const base of urls) {
    try {
      log(`[AI] Trying worker: ${base}`);
      const r = await streamRequest(base, payload);

      if (r.ok && onDelta) {
        onDelta('', '');
      }

      if (!r.ok) {
        const err = await r.text().catch(() => r.statusText);
        lastError = new Error(`Agent ${r.status}: ${err.substring(0, 200)}`);
        log(`[AI] Worker ${base} returned ${r.status}, trying next...`);
        continue; // Try next URL
      }

      const content = await parseSSE(r.body, onDelta);
      if (!content || !content.trim()) {
        lastError = new Error('Empty response from agent');
        continue;
      }

      const latencyMs = Date.now() - startTime;
      log(`[AI] Success from ${base} in ${latencyMs}ms`);
      return { answer: content, latency_ms: latencyMs };
    } catch (e) {
      lastError = e;
      log(`[AI] Worker ${base} failed: ${e.message}`);
      continue; // Try next URL
    }
  }

  // All URLs failed
  throw lastError || new Error('All worker endpoints failed');
}

// Only our known application windows may invoke privileged IPC handlers.
// This prevents a compromised/untrusted renderer from calling file, audio,
// configuration, or AI operations exposed by the main process.
function assertTrustedSender(event) {
  const sender = event?.sender;
  const frame = event?.senderFrame;
  const trusted = [mainWindow, settingsWindow, interviewPanel]
    .filter((win) => win && !win.isDestroyed())
    .some((win) => win.webContents === sender);
  if (frame && frame.isMainFrame === false) throw new Error('Unauthorized IPC frame');
  if (!trusted) throw new Error('Unauthorized IPC sender');
  return sender;
}

// IPC Handlers
ipcMain.handle('get-config', (event) => { assertTrustedSender(event); return config; });
ipcMain.handle('save-config', (event, c) => {
  assertTrustedSender(event);
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  // Allowlist of config keys the renderer can write
  const ALLOWED_KEYS = new Set([
    'workerUrl', 'apiKey', 'model', 'captureDelay', 'hotkeyToggle', 'hotkeyCapture',
    'overlayOpacity', 'fontSize', 'theme', 'micDevice', 'micLanguage',
    'micAutoSendDelay', 'micVadThreshold', 'micGain', 'ocrLanguage', 'focusMode',
    'participants', 'targetName', 'deepgramApiKey', 'sttType', 'eotThreshold',
    'eotTimeoutMs', 'eagerEotThreshold', 'probeModelOnStart', 'resume', 'jobDesc',
    'interviewX', 'interviewY', 'roleName'
  ]);
  for (const key of Object.keys(c)) {
    if (ALLOWED_KEYS.has(key)) {
      config[key] = c[key];
    }
  }
  saveConfig(config);
  return true;
});
ipcMain.handle('toggle-overlay', (event) => { assertTrustedSender(event); return toggleOverlay(); });
ipcMain.handle('start-screen-watch', (event) => { assertTrustedSender(event); startScreenWatch(); return true; });
ipcMain.handle('stop-screen-watch', (event) => { assertTrustedSender(event); stopScreenWatch(); return true; });
ipcMain.handle('manual-capture', async (event) => { assertTrustedSender(event); return await captureScreen(); });
ipcMain.handle('process-capture', async (event, capturePath) => {
  assertTrustedSender(event);
  try {
    await processScreenCapture(capturePath || (await captureScreen()));
    return true;
  } catch (e) {
    console.error('process-capture error:', e.message);
    return false;
  }
});
ipcMain.handle('query-ai', async (event, { prompt, history, taskType }) => {
  assertTrustedSender(event);
  const sender = event.sender;
  let lastSent = '';
  const onDelta = (full) => {
    if (full && full.length - lastSent.length >= 4) {
      sender.send('answer-stream', { type: 'answer', answer: full });
      lastSent = full;
    }
  };
  try {
    const result = await queryAI(prompt, onDelta, history, taskType);
    return result;
  } catch (e) {
    log('[AI] query-ai IPC error:', e.message);
    throw new Error(e.message || 'AI request failed');
  }
});
ipcMain.handle('minimize-to-tray', (event) => { assertTrustedSender(event); if (mainWindow) mainWindow.hide(); });
ipcMain.handle('open-settings', (event) => { assertTrustedSender(event); return openSettings(); });
ipcMain.handle('toggle-interview-panel', (event) => { assertTrustedSender(event); return toggleInterviewPanel(); });
ipcMain.handle('set-interview-position', (event, pos) => {
  assertTrustedSender(event);
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    interviewPanel.setPosition(pos.x, pos.y);
  }
  return true;
});
ipcMain.handle('get-interview-position', (event) => {
  assertTrustedSender(event);
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    const pos = interviewPanel.getPosition();
    return { x: pos[0], y: pos[1] };
  }
  return null;
});
ipcMain.handle('start-window-drag', (event) => {
  assertTrustedSender(event);
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    interviewPanel.startDragging();
  }
  return true;
});

// ── Stealth IPC Handlers ──
ipcMain.handle('set-overlay-opacity', (event, opacity) => {
  assertTrustedSender(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    setOverlayOpacity(mainWindow, opacity);
    config.overlayOpacity = opacity;
    saveConfig(config);
  }
  return true;
});

ipcMain.handle('set-window-click-through', (event, enabled) => {
  assertTrustedSender(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  }
  return true;
});

ipcMain.handle('set-window-title', (event, title) => {
  assertTrustedSender(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (fnSetWindowTextW) {
      const hwndBuf = mainWindow.getNativeWindowHandle();
      const hv = Buffer.isBuffer(hwndBuf)
        ? (hwndBuf.length >= 8 ? hwndBuf.readBigUInt64LE(0) : hwndBuf.readUInt32LE(0))
        : Number(hwndBuf);
      try {
        const encoder = new TextEncoder();
        const buf = Buffer.from(encoder.encode(title + '\0').buffer);
        fnSetWindowTextW(hv, buf);
      } catch (e) {}
    }
  }
  return true;
});

ipcMain.handle('get-stealth-status', (event) => {
  assertTrustedSender(event);
  return {
    antiCapture: !!fnSetWindowDisplayAffinity,
    windowStealth: !!fnSetWindowLongW,
    titleRotation: !!titleRotationInterval,
    overlayOpacity: config.overlayOpacity || 0.95,
  };
});

ipcMain.handle('get-window-list', async (event) => {
  assertTrustedSender(event);
  const sources = await desktopCapturer.getSources({ types: ['window'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

function openSettings() {
  // Settings always open in their own window (with its own preload bridge),
  // which is the only path where settings.html can access the IPC API.
  createSettingsWindow();
  return true;
}

ipcMain.handle('get-screen-info', (event) => {
  assertTrustedSender(event);
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height };
});

ipcMain.handle('get-audio-sources', async (event) => {
  assertTrustedSender(event);
  const sources = await desktopCapturer.getSources({ types: ['audio', 'window'] });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnailDataURL: s.thumbnail.toDataURL() }));
});

// ── Windows Audio Engine (WASAPI loopback) ─────────────────────────────
// Captures the system's audio (or a specific process) at the engine level,
// processes it through the DSP pipeline and streams 16 kHz frames to the
// renderer via 'audio-engine-frame'. No virtual audio drivers required.
const audioSourceManager = new AudioSourceManager();
const audioEngineCaptures = new Map(); // webContents.id -> { capture, sender }

function stopAudioEngineFor(webContentsId) {
  const entry = audioEngineCaptures.get(webContentsId);
  if (entry && entry.capture) {
    try { entry.capture.stop(); } catch (_) { /* best effort */ }
  }
  audioEngineCaptures.delete(webContentsId);
}

ipcMain.handle('get-audio-engine-sources', async (event) => {
  assertTrustedSender(event);
  try {
    const { sources, defaultSource } = await audioSourceManager.enumerateSources();
    return { sources, defaultSource };
  } catch (err) {
    return { sources: [{ pid: null, name: 'System Output (Default device)', kind: 'system', isSystem: true }], defaultSource: null, error: String(err.message || err) };
  }
});

ipcMain.handle('start-audio-engine', (event, opts = {}) => {
  assertTrustedSender(event);
  const sender = event.sender;
  const id = sender.id;
  log(`[AudioEngine] Starting audio engine for webContents ${id}`);
  stopAudioEngineFor(id);

  const source = opts.source || { type: 'system' };
  const vadThreshold = typeof opts.vadThreshold === 'number' ? opts.vadThreshold : 0.015;
  const noiseGate = opts.noiseGate !== false;

  log(`[AudioEngine] Source: ${JSON.stringify(source)}, vadThreshold: ${vadThreshold}`);

  const capture = new WindowsAudioCapture({});
  capture.onFrame = (frame) => {
    if (sender.isDestroyed()) { stopAudioEngineFor(id); return; }
    const pcm = frame.pcm.buffer.slice(frame.pcm.byteOffset, frame.pcm.byteOffset + frame.pcm.byteLength);
    sender.send('audio-engine-frame', {
      pcm,
      sampleRate: frame.sampleRate,
      level: frame.level,
      vad: frame.vad,
      speech: frame.speech,
      classifier: frame.classifier,
      classifierConfidence: frame.classifierConfidence,
      pts: frame.ts,
    });
  };
  capture.onError = (err) => {
    log(`[AudioEngine] Capture error: ${err.message || err}`);
    if (!sender.isDestroyed()) {
      sender.send('audio-engine-event', { type: 'error', message: String((err && err.message) || err) });
    }
  };

  let result;
  try {
    result = capture.start(source, { vadThreshold, noiseGate });
    log(`[AudioEngine] Capture start result: ${JSON.stringify(result)}`);
  } catch (err) {
    log(`[AudioEngine] Capture start exception: ${err.message}`);
    return { ok: false, error: String((err && err.message) || err) };
  }
  if (result.ok) {
    audioEngineCaptures.set(id, { capture, sender });
    log(`[AudioEngine] Audio engine started successfully for webContents ${id}`);
    // Clean up when webContents is destroyed (window closed/crashed)
    sender.on('destroyed', () => stopAudioEngineFor(id));
    sender.on('render-process-gone', () => stopAudioEngineFor(id));
  }
  return { ok: result.ok, running: result.ok, source, metrics: capture.metrics.snapshot() };
});

ipcMain.handle('stop-audio-engine', (event) => {
  assertTrustedSender(event);
  stopAudioEngineFor(event.sender.id);
  return true;
});

ipcMain.handle('get-audio-engine-status', (event) => {
  assertTrustedSender(event);
  const entry = audioEngineCaptures.get(event.sender.id);
  return entry && entry.capture ? entry.capture.snapshot() : { running: false, source: null };
});

// ───────────────────────────────────────────────────────────────────────
// Voice Service (interview panel) — main-process voice engine
// Owns WASAPI capture + DSP + VAD + streaming STT + worker-AI streaming,
// latency instrumentation and the session lifecycle. The existing renderer
// voice pipeline is left untouched; this service is the newer, dedicated
// path wired to the interview panel UI.
// ───────────────────────────────────────────────────────────────────────
const { VoiceService } = require('./voice/voice-service');
let voiceService = null;
let voiceServiceInitPromise = null;

function getVoiceService() {
  if (voiceService) return voiceService;
  voiceService = new VoiceService({
    config: {
      deepgramApiKey: config.deepgramApiKey || '',
      workerUrl: config.workerUrl || '',
      defaultWorkerUrl: DEFAULT_WORKER_URL,
      apiKey: config.apiKey || '',
      resume: config.resume,
      jobDesc: config.jobDesc,
      targetName: config.targetName,
      participants: config.participants,
      audioSourceId: config.audioSourceId,
      audioSourceName: config.audioSourceName,
      sampleRate: 16000,
      model: (config.model && config.model !== 'auto') ? config.model : 'auto',
      sttModel: config.sttModel || 'flux-general-en',
      eagerAnswer: config.eagerAnswer !== false,
      eagerEotThreshold: config.eagerEotThreshold ?? 0.5,
      eotThreshold: config.eotThreshold ?? 0.5,
      eotTimeoutMs: config.eotTimeoutMs ?? 1500,
      endGraceMs: config.endGraceMs ?? 800,
      // Whis-AI-style early answer: fire generation as soon as a partial is a
      // confident question (mid-interviewer-speech) instead of waiting for
      // end-of-turn. Tunable; defaults keep the 2s budget.
      earlyAnswerOnPartial: config.earlyAnswerOnPartial !== false,
      partialMinLength: config.partialMinLength ?? 16,
      partialQuestionThreshold: config.partialQuestionThreshold ?? 0.55,
      voiceAnswerEndpoint: !!config.voiceAnswerEndpoint,
      probeModelOnStart: config.probeModelOnStart !== false,
      modelCacheFile: path.join(USER_DATA_PATH, 'voice-model-cache.json'),
      log: (...a) => log('[Voice]', ...a),
    },
    emitToRenderer: (channel, payload) => {
      const targets = [];
      if (interviewPanel && !interviewPanel.isDestroyed()) targets.push(interviewPanel);
      for (const w of targets) {
        try { w.webContents.send(channel, payload); } catch (_) { /* */ }
      }
      if (!targets.length && mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.webContents.send(channel, payload); } catch (_) { /* */ }
      }
    },
  });
  voiceServiceInitPromise = voiceService.init().catch((err) => {
    log('[Voice] init error:', err && err.message || err);
    throw err;
  });
  return voiceService;
}

async function ensureVoiceService() {
  const svc = getVoiceService();
  if (voiceServiceInitPromise) await voiceServiceInitPromise;
  return svc;
}

ipcMain.handle('voice:get-sources', async (event) => {
  assertTrustedSender(event);
  const svc = await ensureVoiceService();
  const sources = await svc.listSources();
  return { sources, selected: svc.sourceManager.selected, state: svc.sourceManager.selectedState };
});

ipcMain.handle('voice:select-source', async (event, id) => {
  assertTrustedSender(event);
  const svc = await ensureVoiceService();
  return svc.selectSource(id);
});

ipcMain.handle('voice:start', async (event) => {
  assertTrustedSender(event);
  const svc = await ensureVoiceService();
  return svc.start();
});

ipcMain.handle('voice:stop', async (event) => {
  assertTrustedSender(event);
  const svc = await ensureVoiceService();
  await svc.stop();
  return { ok: true };
});

ipcMain.handle('voice:set-listening', (event, enabled) => {
  assertTrustedSender(event);
  if (!voiceService) return { ok: false, error: 'not-started' };
  return voiceService.setListening(!!enabled);
});

ipcMain.handle('voice:get-diagnostics', (event) => {
  assertTrustedSender(event);
  if (!voiceService) return null;
  return voiceService.getDiagnostics();
});

ipcMain.handle('voice:get-latency', (event) => {
  assertTrustedSender(event);
  if (!voiceService) return null;
  return { last: voiceService.latency.last, stats: voiceService.latency.stats() };
});

ipcMain.handle('voice:report-ui-latency', (event, ms) => {
  assertTrustedSender(event);
  if (!voiceService) return;
  voiceService.reportUiLatency(typeof ms === 'number' ? ms : NaN);
});

// Mic frames pushed from the renderer (getUserMedia) when Microphone is the
// selected source. 48 kHz mono int16 PCM.
ipcMain.on('voice:mic-frame', (event, buffer) => {
  assertTrustedSender(event);
  if (!voiceService) return;
  voiceService.pushMicFrame(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []));
});

// Snippet management
ipcMain.handle('save-snippet', async (event, { title, content, category }) => {
  assertTrustedSender(event);
  const snippetsDir = path.join(USER_DATA_PATH, 'snippets');
  if (!fs.existsSync(snippetsDir)) fs.mkdirSync(snippetsDir, { recursive: true });
  const filename = `${category || 'general'}_${Date.now()}.json`;
  const snippet = { title, content, category, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(snippetsDir, filename), JSON.stringify(snippet, null, 2));
  return true;
});

ipcMain.handle('load-snippets', async (event) => {
  assertTrustedSender(event);
  const snippetsDir = path.join(USER_DATA_PATH, 'snippets');
  if (!fs.existsSync(snippetsDir)) return [];
  const files = fs.readdirSync(snippetsDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(snippetsDir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle('delete-snippet', async (event, { title, createdAt }) => {
  assertTrustedSender(event);
  const snippetsDir = path.join(USER_DATA_PATH, 'snippets');
  if (!fs.existsSync(snippetsDir)) return false;
  const files = fs.readdirSync(snippetsDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(snippetsDir, f), 'utf8'));
      if (s.title === title && s.createdAt === createdAt) {
        fs.unlinkSync(path.join(snippetsDir, f));
        return true;
      }
    } catch { /* continue */ }
  }
  return false;
});

// History management
const HISTORY_PATH = path.join(USER_DATA_PATH, 'history.json');

function loadHistoryFromFile() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading history:', e.message);
  }
  return [];
}

function saveHistoryToFile(history) {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
    return true;
  } catch (e) {
    console.error('Error saving history:', e.message);
    return false;
  }
}

ipcMain.handle('save-history', async (event, { question, answer, type, metadata }) => {
  assertTrustedSender(event);
  try {
    const history = loadHistoryFromFile();
    const entry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      question: question || '',
      answer: answer || '',
      type: type || 'unknown',
      metadata: metadata || {}
    };
    history.unshift(entry);
    if (history.length > 1000) history.length = 1000;
    return { success: saveHistoryToFile(history), count: history.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('load-history', async (event) => {
  assertTrustedSender(event);
  try {
    return { success: true, history: loadHistoryFromFile() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-history', async (event) => {
  assertTrustedSender(event);
  try {
    saveHistoryToFile([]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('export-history', async (event, { format }) => {
  assertTrustedSender(event);
  try {
    const history = loadHistoryFromFile();
    if (format === 'csv') {
      const headers = ['timestamp', 'question', 'answer', 'type'];
      const rows = history.map(entry =>
        [entry.timestamp, entry.question, entry.answer, entry.type]
          .map(val => `"${String(val || '').replace(/"/g, '""')}"`)
          .join(',')
      );
      return { success: true, data: [headers.join(','), ...rows].join('\n'), mimeType: 'text/csv' };
    }
    return { success: true, data: JSON.stringify(history, null, 2), mimeType: 'application/json' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// File upload handlers
const RESUME_PATH = path.join(USER_DATA_PATH, 'resume.txt');
const JOB_DESC_PATH = path.join(USER_DATA_PATH, 'job_desc.txt');

ipcMain.handle('upload-resume', async (event, { fileData }) => {
  assertTrustedSender(event);
  try {
    fs.writeFileSync(RESUME_PATH, fileData, 'utf8');
    config.resume = fileData;
    saveConfig(config);
    if (mainWindow) mainWindow.webContents.send('resume-updated');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('upload-job-desc', async (event, { fileData }) => {
  assertTrustedSender(event);
  try {
    fs.writeFileSync(JOB_DESC_PATH, fileData, 'utf8');
    config.jobDesc = fileData;
    saveConfig(config);
    if (mainWindow) mainWindow.webContents.send('job-desc-updated');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-resume', async (event) => {
  assertTrustedSender(event);
  try {
    if (fs.existsSync(RESUME_PATH)) {
      return { success: true, content: fs.readFileSync(RESUME_PATH, 'utf8') };
    }
    return { success: false, content: '' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-job-desc', async (event) => {
  assertTrustedSender(event);
  try {
    if (fs.existsSync(JOB_DESC_PATH)) {
      return { success: true, content: fs.readFileSync(JOB_DESC_PATH, 'utf8') };
    }
    return { success: false, content: '' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Speech-to-text via the DevOps AI Agent worker
ipcMain.handle('transcribe-audio', async (event, { audioBase64, mimeType }) => {
  assertTrustedSender(event);
  try {
    const base = (config.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
    if (!base) {
      return { text: '', error: 'Worker URL not configured' };
    }

    if (!audioBase64) {
      return { text: '', error: 'Empty audio: no audio data supplied' };
    }

    let audioBytes;
    try {
      audioBytes = Buffer.from(audioBase64, 'base64');
    } catch (e) {
      return { text: '', error: 'Invalid audio encoding: ' + e.message };
    }

    if (audioBytes.length === 0) {
      return { text: '', error: 'Empty audio: decoded audio is zero bytes' };
    }

    // Whichever mime/format the client reports, normalize to audio/*.
    let mime = mimeType || 'audio/webm';
    if (typeof mime === 'string' && !/^audio\//i.test(mime)) mime = 'audio/' + String(mime).replace(/^\./, '');

    const fmt = (mime && mime.match(/\/[a-z0-9+.-]+/i)) ? mime.match(/\/[a-z0-9+.-]+/i)[0].slice(1) : 'webm';

    // Prefer the dedicated transcription endpoint; fall back to chat completions
    // as a last resort for backwards compatibility.
    const endpoints = [
      { url: '/v1/audio/transcriptions', sendFile: true },
      { url: '/v1/chat/completions', sendFile: false },
    ];

    let lastError = null;
    for (const { url, sendFile } of endpoints) {
      let r;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`;

        const body = sendFile
          ? {
              model: config.model || 'auto',
              file: audioBase64,
              mime_type: mime,
              format: fmt,
              language: config.micLanguage && config.micLanguage !== 'en' ? config.micLanguage : undefined,
            }
          : {
              model: config.model || 'auto',
              messages: [{ role: 'user', audio: audioBase64, mime_type: mime }],
            };

        r = await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) {
        lastError = e;
        continue;
      }

      if (r.status === 404 || r.status === 405 || r.status === 501) {
        lastError = new Error(`Endpoint ${url} not supported (${r.status})`);
        continue;
      }

      if (!r.ok) {
        const errText = await r.text().catch(() => r.statusText);
        lastError = new Error(`STT ${r.status}: ${String(errText).substring(0, 200)}`);
        if (r.status >= 500) continue;
        break;
      }

      const result = await r.json().catch(() => null);
      if (result && result.error) { lastError = new Error(result.error); continue; }
      const text = result?.choices?.[0]?.message?.content ||
                   result?.text ||
                   result?.transcription ||
                   '';
      if (text) {
        return {
          text: String(text).trim(),
          error: null,
          model: result?.model || undefined,
          segments: Array.isArray(result?.segments) ? result.segments : undefined,
        };
      }
      lastError = new Error('Empty transcription result');
      continue;
    }

    return { text: '', error: lastError ? lastError.message : 'Transcription failed' };
  } catch (e) {
    console.error('Transcribe error:', e.message);
    return { text: '', error: e.message };
  }
});

// App
app.whenReady().then(async () => {
  log('[Main] App is ready');
  const { session } = require('electron');

  // Grant only the media permission required by the local application UI.
  // Do not globally approve notifications, filesystem, HID, serial, etc.
  const isTrustedOrigin = (origin) => {
    if (!origin) return false;
    return origin === 'file://' || origin.startsWith('file://');
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = webContents?.getURL?.() || '';
    callback(permission === 'media' && isTrustedOrigin(origin));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === 'media' && isTrustedOrigin(requestingOrigin);
  });

  // ── Enhanced User-Agent: strip Electron, Chrome headless, and append realistic strings ──
  const baseUA = session.defaultSession.getUserAgent();
  const stealthUA = baseUA
    .replace(/Electron\/[\d.]+\s*/g, '')
    .replace(/devops-ai-agent\/[\d.]+\s*/g, '')
    .replace(/\s*ElectronBuilder\/[\d.]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  session.defaultSession.setUserAgent(stealthUA);

  // ── Inject navigator spoofing into every renderer ──
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // Set realistic Sec-CH-UA headers (Chrome brand headers)
    headers['Sec-CH-UA'] = ['"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"'];
    headers['Sec-CH-UA-Mobile'] = ['?0'];
    headers['Sec-CH-UA-Platform'] = ['"Windows"'];
    // Remove identification headers
    delete headers['X-Electron'];
    delete headers['X-Frame-Options'];
    callback({ responseHeaders: headers });
  });

  // Inject stealth script into every page load
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({});
  });

  createMainWindow();
  createTray();
  startStealthReapply();

  // Forward renderer console output
  const fwd = (wc) => {
    wc.on('console-message', (e, level, message, line, sourceId) => {
      log(`[renderer] (${level}) ${message}`);
    });
    wc.on('render-process-gone', (e, details) => {
      log(`[renderer] process-gone: ${JSON.stringify(details)}`);
    });
  };
  fwd(mainWindow.webContents);

  // ── Inject navigator anti-detection into every new window ──
  app.on('web-contents-created', (event, contents) => {
    contents.on('did-finish-load', () => {
      // Override navigator properties to hide Electron fingerprint
      // NOTE: preload.js handles most overrides before page load.
      // This is a backup injection for any pages that bypass preload.
      const stealthScript = `
        // Override navigator.webdriver (headless/Electron detection)
        if (!('webdriver' in navigator) || navigator.webdriver !== undefined) {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        }

        // Override navigator.plugins (empty in Electron, real Chrome has plugins)
        if (navigator.plugins && navigator.plugins.length === 0) {
          Object.defineProperty(navigator, 'plugins', {
            get: () => {
              const plugins = [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
              ];
              plugins.length = 3;
              return plugins;
            },
          });
        }

        // Override navigator.languages (ensure consistent locale)
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

        // Override navigator.connection.rtt (Electron returns 0)
        if (navigator.connection) {
          try { Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 }); } catch(e) {}
        }

        // Override navigator.hardwareConcurrency
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });

        // Override navigator.deviceMemory
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

        // Delete Electron identifiers
        try { delete window.electron; } catch(e) {}
        try { delete window.require; } catch(e) {}
        try { delete window.module; } catch(e) {}
        try { delete window.exports; } catch(e) {}
        try { delete window.__dirname; } catch(e) {}
        try { delete window.__filename; } catch(e) {}

        // Override permissions query (notifications should be default, not denied)
        const origQuery = navigator.permissions.query;
        navigator.permissions.query = (params) => {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return origQuery.call(navigator.permissions, params);
        };

        // Hide Chrome DevTools detection via runtime.enable
        if (window.chrome) {
          window.chrome.runtime = window.chrome.runtime || { connect: () => {}, sendMessage: () => {} };
        }

        // Override console.debug to prevent DevTools detection
        const origDebug = console.debug;
        console.debug = function(...args) {
          if (args[0] && typeof args[0] === 'string' && args[0].includes('debugger')) return;
          return origDebug.apply(console, args);
        };

        // Override window.outerWidth/outerHeight (Electron can differ from inner)
        try {
          Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
          Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
        } catch(e) {}

        // Override screen.colorDepth (Electron sometimes returns 32)
        try { Object.defineProperty(screen, 'colorDepth', { get: () => 24 }); } catch(e) {}
      `;
      contents.executeJavaScript(stealthScript).catch(() => {});
    });
  });

  try {
    globalShortcut.register(config.hotkeyToggle, () => toggleOverlay());
  } catch (_) { /* already bound */ }
  try {
    globalShortcut.register('Esc', () => {
      if (settingsWindow && settingsWindow.isFocused()) { settingsWindow.close(); return; }
      toggleOverlay();
    });
  } catch (_) { /* already bound */ }
  try {
    globalShortcut.register(config.hotkeyCapture, async () => {
      const p = await captureScreen();
      if (p && mainWindow) mainWindow.webContents.send('screen-captured', p);
    });
  } catch (_) { /* already bound */ }
  try {
    globalShortcut.register('CommandOrControl+Shift+S', () => {
      isScreenWatching ? stopScreenWatch() : startScreenWatch();
    });
  } catch (_) { /* already bound */ }
  try {
    globalShortcut.register('CommandOrControl+Shift+M', () => {
      if (mainWindow) mainWindow.webContents.send('toggle-mic');
      if (interviewPanel && !interviewPanel.isDestroyed()) {
        interviewPanel.webContents.send('toggle-mic');
      }
    });
  } catch (_) { /* already bound */ }
  try {
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      toggleInterviewPanel();
    });
  } catch (_) { /* already bound */ }

  // Latency HUD toggle (Ctrl+Shift+D) — shown in the interview panel UI.
  const sendHudToggle = () => {
    if (interviewPanel && !interviewPanel.isDestroyed()) {
      interviewPanel.webContents.send('voice:hud-toggle');
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('voice:hud-toggle');
    }
  };
  try {
    globalShortcut.register('CommandOrControl+Shift+D', sendHudToggle);
  } catch (_) { /* already bound (rare) */ }

  // ── Whis-AI style hotkeys ───────────────────────────────────────
  // Ctrl+H: Panic hide — instantly hide ALL windows
  try {
    globalShortcut.register('CommandOrControl+H', () => {
      const allWindows = BrowserWindow.getAllWindows();
      const anyVisible = allWindows.some(w => !w.isDestroyed() && w.isVisible());
      if (anyVisible) {
        // Hide everything
        for (const w of allWindows) {
          if (w && !w.isDestroyed() && w.isVisible()) w.hide();
        }
        isOverlayVisible = false;
        isInterviewVisible = false;
        log('[Hotkey] Ctrl+H: All windows hidden (panic mode)');
      } else {
        // Restore everything
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
          applyAntiCaptureWithRetry(mainWindow);
          applyWindowStealth(mainWindow);
          mainWindow.focus();
          isOverlayVisible = true;
        }
        if (interviewPanel && !interviewPanel.isDestroyed()) {
          interviewPanel.show();
          interviewPanel.focus();
          applyAntiCaptureWithRetry(interviewPanel);
          isInterviewVisible = true;
        }
        log('[Hotkey] Ctrl+H: All windows restored');
      }
    });
  } catch (_) { /* already bound */ }

  // Ctrl+L: Toggle audio/listening on interview panel
  try {
    globalShortcut.register('CommandOrControl+L', () => {
      if (interviewPanel && !interviewPanel.isDestroyed()) {
        interviewPanel.webContents.send('toggle-mic');
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-mic');
      }
      log('[Hotkey] Ctrl+L: Toggle audio');
    });
  } catch (_) { /* already bound */ }

  // Ctrl+J: Silent screen capture + OCR
  try {
    globalShortcut.register('CommandOrControl+J', async () => {
      const p = await captureScreen();
      if (p) {
        // Send to both windows for processing
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('screen-captured', p);
        }
        if (interviewPanel && !interviewPanel.isDestroyed()) {
          interviewPanel.webContents.send('screen-captured', p);
        }
        // Auto-process OCR silently
        processScreenCapture(p).catch(() => {});
        log('[Hotkey] Ctrl+J: Silent screen capture');
      }
    });
  } catch (_) { /* already bound */ }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('will-quit', async () => {
  stopTitleRotation();
  stopStealthReapply();
  globalShortcut.unregisterAll();
  stopScreenWatch();
  if (voiceService) {
    try { await voiceService.stop(); } catch (_) { /* */ }
  }
  if (ocrEngine) await ocrEngine.terminate();
});
