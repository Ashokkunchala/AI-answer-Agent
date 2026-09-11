const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const fs = require('fs');
const OCREngine = require('./ocr-engine');

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

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

      // Load resume from file if exists
      try {
        const resumePath = path.join(app.getPath('userData'), 'resume.txt');
        if (fs.existsSync(resumePath)) {
          config.resume = fs.readFileSync(resumePath, 'utf8');
        }
      } catch (e) { /* ignore */ }

      // Load job description from file if exists
      try {
        const jobDescPath = path.join(app.getPath('userData'), 'job_desc.txt');
        if (fs.existsSync(jobDescPath)) {
          config.jobDesc = fs.readFileSync(jobDescPath, 'utf8');
        }
      } catch (e) { /* ignore */ }

      return config;
    }
  } catch (e) { /* ignore */ }
  return {
    workerUrl: DEFAULT_WORKER_URL,
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
    // Interview panel / voice service
    deepgramApiKey: '',
    sttType: 'auto',
    interviewX: null,
    interviewY: null,
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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

  // 1. Set extended window style: ToolWindow (hidden from Alt+Tab) + NoActivate (won't steal focus)
  if (fnGetWindowLongW && fnSetWindowLongW) {
    try {
      const exStyle = fnGetWindowLongW(handleValue, GWL_EXSTYLE);
      const newStyle = exStyle | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
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

  interviewPanel.on('move', () => {
    // Save position for next open
    try {
      const pos = interviewPanel.getPosition();
      const cfg = loadConfig();
      cfg.interviewX = pos[0];
      cfg.interviewY = pos[1];
      saveConfig(cfg);
    } catch (e) {}
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
        mainWindow.webContents.send('answer-ready', {
          type: 'ocr',
          text: detected.question.substring(0, 500),
          confidence: result.confidence
        });

        // Auto-query AI
        try {
          const answer = await queryAI(aiPrompt);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer-ready', {
              type: 'answer',
              question: detected.question.substring(0, 200),
              answer: answer,
              provider: 'DevOps AI Agent',
              model: config.model
            });
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
      const j = JSON.parse(data);
      const delta = j.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(full, delta);
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
  const base = (config.workerUrl || DEFAULT_WORKER_URL).replace(/\/+$/, '');
  if (!base) {
    throw new Error('Worker URL not configured. Open Settings and enter your worker URL.');
  }

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

  // Single attempt - worker handles model fallback internally
  try {
    const r = await streamRequest(base, payload);

    if (r.ok && onDelta) {
      onDelta('', '');
    }

    if (!r.ok) {
      const err = await r.text().catch(() => r.statusText);
      throw new Error(`Agent ${r.status}: ${err.substring(0, 200)}`);
    }

    const content = await parseSSE(r.body, onDelta);
    if (!content || !content.trim()) throw new Error('Empty response from agent');

    const latencyMs = Date.now() - startTime;
    return { answer: content, latency_ms: latencyMs };
  } catch (e) {
    lastError = e;
    throw e;
  }
}

// IPC Handlers
ipcMain.handle('get-config', () => config);
ipcMain.handle('save-config', (event, c) => {
  Object.assign(config, c);
  saveConfig(config);
  return true;
});
ipcMain.handle('toggle-overlay', () => toggleOverlay());
ipcMain.handle('start-screen-watch', () => { startScreenWatch(); return true; });
ipcMain.handle('stop-screen-watch', () => { stopScreenWatch(); return true; });
ipcMain.handle('manual-capture', async () => await captureScreen());
ipcMain.handle('process-capture', async (event, capturePath) => {
  try {
    await processScreenCapture(capturePath || (await captureScreen()));
    return true;
  } catch (e) {
    console.error('process-capture error:', e.message);
    return false;
  }
});
ipcMain.handle('query-ai', async (event, { prompt, history, taskType }) => {
  const sender = event.sender;
  let lastSent = '';
  const onDelta = (full) => {
    if (full && full.length - lastSent.length >= 4) {
      sender.send('answer-stream', { type: 'answer', answer: full });
      lastSent = full;
    }
  };
  return await queryAI(prompt, onDelta, history, taskType);
});
ipcMain.handle('minimize-to-tray', () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle('open-settings', () => openSettings());
ipcMain.handle('toggle-interview-panel', () => toggleInterviewPanel());
ipcMain.handle('set-interview-position', (event, pos) => {
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    interviewPanel.setPosition(pos.x, pos.y);
  }
  return true;
});
ipcMain.handle('get-interview-position', () => {
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    const pos = interviewPanel.getPosition();
    return { x: pos[0], y: pos[1] };
  }
  return null;
});
ipcMain.handle('start-window-drag', () => {
  if (interviewPanel && !interviewPanel.isDestroyed()) {
    interviewPanel.startDragging();
  }
  return true;
});

// ── Stealth IPC Handlers ──
ipcMain.handle('set-overlay-opacity', (event, opacity) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    setOverlayOpacity(mainWindow, opacity);
    config.overlayOpacity = opacity;
    saveConfig(config);
  }
  return true;
});

ipcMain.handle('set-window-click-through', (event, enabled) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  }
  return true;
});

ipcMain.handle('set-window-title', (event, title) => {
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

ipcMain.handle('get-stealth-status', () => {
  return {
    antiCapture: !!fnSetWindowDisplayAffinity,
    windowStealth: !!fnSetWindowLongW,
    titleRotation: !!titleRotationInterval,
    overlayOpacity: config.overlayOpacity || 0.95,
  };
});

ipcMain.handle('get-window-list', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window'] });
  return sources.map(s => ({ id: s.id, name: s.name }));
});

function openSettings() {
  // Settings always open in their own window (with its own preload bridge),
  // which is the only path where settings.html can access the IPC API.
  createSettingsWindow();
  return true;
}

ipcMain.handle('get-screen-info', () => {
  const d = screen.getPrimaryDisplay();
  return { width: d.size.width, height: d.size.height };
});

ipcMain.handle('get-audio-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['audio', 'window'] });
  return sources.map(s => ({ id: s.id, name: s.name, thumbnailDataURL: s.thumbnail.toDataURL() }));
});

// Snippet management
ipcMain.handle('save-snippet', async (event, { title, content, category }) => {
  const snippetsDir = path.join(USER_DATA_PATH, 'snippets');
  if (!fs.existsSync(snippetsDir)) fs.mkdirSync(snippetsDir, { recursive: true });
  const filename = `${category || 'general'}_${Date.now()}.json`;
  const snippet = { title, content, category, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(snippetsDir, filename), JSON.stringify(snippet, null, 2));
  return true;
});

ipcMain.handle('load-snippets', async () => {
  const snippetsDir = path.join(USER_DATA_PATH, 'snippets');
  if (!fs.existsSync(snippetsDir)) return [];
  const files = fs.readdirSync(snippetsDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(snippetsDir, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

ipcMain.handle('delete-snippet', async (event, { title, createdAt }) => {
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

ipcMain.handle('load-history', async () => {
  try {
    return { success: true, history: loadHistoryFromFile() };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('clear-history', async () => {
  try {
    saveHistoryToFile([]);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('export-history', async (event, { format }) => {
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

ipcMain.handle('get-resume', async () => {
  try {
    if (fs.existsSync(RESUME_PATH)) {
      return { success: true, content: fs.readFileSync(RESUME_PATH, 'utf8') };
    }
    return { success: false, content: '' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-job-desc', async () => {
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

  // Auto-grant media permissions
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

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

  globalShortcut.register(config.hotkeyToggle, () => toggleOverlay());
  globalShortcut.register('Esc', () => {
    if (settingsWindow && settingsWindow.isFocused()) { settingsWindow.close(); return; }
    toggleOverlay();
  });
  globalShortcut.register(config.hotkeyCapture, async () => {
    const p = await captureScreen();
    if (p && mainWindow) mainWindow.webContents.send('screen-captured', p);
  });
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    isScreenWatching ? stopScreenWatch() : startScreenWatch();
  });
  globalShortcut.register('CommandOrControl+Shift+M', () => {
    if (mainWindow) mainWindow.webContents.send('toggle-mic');
    if (interviewPanel && !interviewPanel.isDestroyed()) {
      interviewPanel.webContents.send('toggle-mic');
    }
  });
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    toggleInterviewPanel();
  });

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
  if (ocrEngine) await ocrEngine.terminate();
});
