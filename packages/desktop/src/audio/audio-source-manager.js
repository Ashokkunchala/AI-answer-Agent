// audio-source-manager.js — capturable audio sources.
//
// Sources are:
//   * system  — the default render device loopback (what the native addon
//               captures with startSystemAudio). deviceId reflects the
//               WASAPI endpoint reported by AudioDeviceManager.
//   * process — a specific audible app (pid + optional process tree).
//   * mic     — a specific capture endpoint (deviceId). Mic capture is
//               optional and OFF unless the user explicitly picks it.
//
// Selection state, switching (system <-> process <-> mic) and automatic
// fallback are tracked here so the service can react to device change and
// process-exit events without tearing everything down.
'use strict';

const { spawn } = require('child_process');

const KNOWN_AUDIO_APPS = [
  'chrome', 'msedge', 'teams', 'zoom', 'brave', 'opera', 'firefox',
  'slack', 'discord', 'spotify', 'vlc', 'wmplayer', 'itunes',
  'electron', 'explorer', 'msteams', 'wechat', 'ths',
];

function listAudioProcesses(knownApps = KNOWN_AUDIO_APPS, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const script = `
$known = @($(${knownApps.map((s) => `'${s}'`).join(', ')}));
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 0 -and ($_.MainWindowTitle -or ($known -contains $_.ProcessName)) };
$procs | Sort-Object ProcessName | Select-Object -Unique -Property Id, ProcessName, @{N='Title';E={$_.MainWindowTitle}} | ConvertTo-Json -Compress
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve([]); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout.trim());
        const arr = Array.isArray(data) ? data : (data ? [data] : []);
        resolve(arr.map((r) => ({
          pid: Number(r.Id),
          processName: String(r.ProcessName || ''),
          title: String(r.Title || ''),
        })));
      } catch (_) {
        resolve([]);
      }
    });
  });
}

const SRC_KIND = { SYSTEM: 'system', PROCESS: 'process', MIC: 'mic' };
const SRC_STATE = {
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  SWITCHING: 'switching',
  FALLBACK: 'fallback',
  ERROR: 'error',
};

class AudioSourceManager {
  constructor(options = {}) {
    this.deviceManager = options.deviceManager || null;
    this.knownApps = options.knownApps || KNOWN_AUDIO_APPS;
    this.listProcesses = options.listProcesses || listAudioProcesses;
    this.sources = [];
    this.selected = null;    // { kind, pid, deviceId, name, state }
    this.selectedState = SRC_STATE.DISCONNECTED;
    this.onSourcesChanged = null;  // (sources, selected, state) => void
    this._processCache = { list: [], at: 0 };
  }

  // Build the full source list from device + process enumeration.
  async enumerate(force = false) {
    let devices = [];
    if (this.deviceManager) {
      try {
        devices = this.deviceManager.getDevices() || [];
      } catch (_) { /* */ }
    }

    const now = Date.now();
    if (force || now - this._processCache.at > 8000) {
      try {
        this._processCache.list = await this.listProcesses(this.knownApps);
      } catch (_) {
        this._processCache.list = this._processCache.list || [];
      }
      this._processCache.at = now;
    }

    this.sources = this.#buildSources(devices, this._processCache.list);

    if (this.onSourcesChanged) {
      try { this.onSourcesChanged(this.sources, this.selected, this.selectedState); } catch (_) { /* */ }
    }
    return this.sources;
  }

  #buildSources(devices, procs) {
    const list = [];

    // System output loopback (always first).
    const defaultRender = (devices || []).find((d) => d.flow === 'render' && d.default) || null;
    list.push({
      id: 'system',
      kind: SRC_KIND.SYSTEM,
      name: 'System Output (Default device)',
      device: defaultRender ? { id: defaultRender.id, name: defaultRender.name, bluetooth: !!defaultRender.bluetooth } : null,
    });

    // Expose every active Windows capture endpoint, not only the default mic.
    // The renderer performs the final Chromium/Electron device mapping, so
    // keeping the WASAPI endpoint id here is useful for diagnostics/selection
    // but must not be assumed to be the same id returned by enumerateDevices().
    const captureMics = (devices || [])
      .filter((d) => d.flow === 'capture' && d.state === 'active')
      .sort((a, b) => Number(!!b.default) - Number(!!a.default) || String(a.name || '').localeCompare(String(b.name || '')));
    for (const mic of captureMics) {
      list.push({
        id: 'mic:' + mic.id,
        kind: SRC_KIND.MIC,
        name: 'Microphone (' + mic.name + ')' + (mic.default ? ' [Default]' : ''),
        deviceId: mic.id,
        device: {
          id: mic.id,
          name: mic.name,
          bluetooth: !!mic.bluetooth,
          default: !!mic.default,
          state: mic.state,
        },
      });
    }

    // Audio-rendering application processes.
    for (const p of procs || []) {
      list.push({
        id: 'proc:' + p.pid,
        kind: SRC_KIND.PROCESS,
        pid: p.pid,
        name: p.title || p.processName || 'PID ' + p.pid,
        processName: p.processName,
      });
    }
    return list;
  }

  // Select a source by id ('system' | 'proc:<pid>' | 'mic:<deviceId>').
  select(id) {
    const src = this.sources.find((s) => s.id === id);
    if (!src) return { ok: false, error: 'unknown-source' };
    if (this.selected && this.selected.id === id) {
      return { ok: true, source: this.selected };
    }
    const prev = this.selected;
    this.selected = {
      id: src.id,
      kind: src.kind,
      pid: src.pid || null,
      deviceId: src.deviceId || null,
      name: src.name,
    };
    this.selectedState = prev ? SRC_STATE.SWITCHING : SRC_STATE.CONNECTING;
    if (this.onSourcesChanged) {
      try { this.onSourcesChanged(this.sources, this.selected, this.selectedState); } catch (_) { /* */ }
    }
    return { ok: true, source: this.selected, prev };
  }

  setState(state) {
    this.selectedState = state;
    if (this.onSourcesChanged) {
      try { this.onSourcesChanged(this.sources, this.selected, this.selectedState); } catch (_) { /* */ }
    }
    return this.selectedState;
  }

  // Automatic recovery used by the service when the current source breaks.
  async fallbackToDefault() {
    if (this.deviceManager) {
      try { await this.deviceManager.refresh(); } catch (_) { /* */ }
    }
    const sys = this.sources.find((s) => s.id === 'system');
    if (!sys) return { ok: false, error: 'no-system-source' };
    const prev = this.selected;
    this.selected = {
      id: sys.id,
      kind: sys.kind,
      pid: null,
      deviceId: null,
      name: sys.name,
    };
    this.selectedState = SRC_STATE.FALLBACK;
    if (this.onSourcesChanged) {
      try { this.onSourcesChanged(this.sources, this.selected, this.selectedState); } catch (_) { /* */ }
    }
    return { ok: true, source: this.selected, prev };
  }

  isProcessAlive() {
    if (!this.selected || this.selected.kind !== SRC_KIND.PROCESS) return true;
    return this._processCache.list.some((p) => p.pid === this.selected.pid);
  }

  // Mark a detected process exit so the service can decide a fallback.
  handleProcessExit(pid) {
    if (!this.selected || this.selected.kind !== SRC_KIND.PROCESS) return false;
    if (this.selected.pid !== pid) return false;
    return true; // caller decides
  }

  snapshot() {
    return {
      sources: this.sources,
      selected: this.selected,
      selectedState: this.selectedState,
    };
  }
}

module.exports = { AudioSourceManager, SRC_KIND, SRC_STATE, listAudioProcesses, KNOWN_AUDIO_APPS };