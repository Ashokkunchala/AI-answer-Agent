// windows-audio-capture.js — WASAPI loopback session capture.
// Wraps the native `loopback-capture` addon (Windows Audio Engine / WASAPI
// loopback) and drives the AudioProcessingPipeline in the Electron main
// process. Emits ready-to-transcribe 20ms Int16 frames to the renderer.
'use strict';

const { spawn } = require('child_process');
const LoopbackCapture = require('loopback-capture').LoopbackCapture;
const { AudioProcessingPipeline } = require('./audio-processing-pipeline');
const { AudioMetrics } = require('./audio-metrics');

// --- WindowsAudioCapture -------------------------------------------------
class WindowsAudioCapture {
  constructor(options = {}) {
    this.sampleRate = options.sampleRate || 16000;
    this.blobRateMs = options.blobRateMs || 16;
    this.metrics = new AudioMetrics();
    this.capture = null;
    this.pipeline = null;
    this.source = null;           // { type:'system' } | { type:'process', pid }
    this.onFrame = null;          // (frame) => void
    this.onError = null;          // (err) => void
    this.running = false;
    this.rawQueue = [];
    this._timer = null;
  }

  get isRunning() { return this.running; }

  // source: { type:'system' } or { type:'process', pid }
  start(source, options = {}) {
    if (this.running) this.stop();

    this.source = source;
    this.pipeline = new AudioProcessingPipeline({
      inRate: 48000,
      channels: 2,
      outRate: this.sampleRate,
      frameMs: options.frameMs || 20,
      vadThreshold: options.vadThreshold ?? 0.015,
      noiseGate: options.noiseGate !== false,
      metrics: this.metrics,
    });
    this.rawQueue = [];
    this.metrics.beginCapture();

    this.capture = new LoopbackCapture();

    const onChunk = (chunk) => { this._onRawChunk(chunk); };
    let started = false;
    try {
      if (source && source.type === 'process' && source.pid) {
        this.capture.start(source.pid, true, onChunk);
      } else {
        this.capture.startSystemAudio(onChunk);
      }
      started = true;
    } catch (err) {
      this._reportError(err);
    }

    this.running = started;
    if (started) {
      this._timer = setInterval(() => this._drain(), this.blobRateMs);
      this._timer.unref && this._timer.unref();
    }
    return { ok: started, source: this.source };
  }

  _onRawChunk(chunk) {
    if (!this.running) return;
    if (this.rawQueue.length > 240) {
      // Main process fell behind; drop oldest, count as dropped.
      this.metrics.framesDropped++;
      this.rawQueue.shift();
    }
    this.rawQueue.push(chunk);
  }

  _drain() {
    if (!this.running) return;
    const chunk = this.rawQueue.shift();
    if (!chunk) return;

    let frames;
    try {
      frames = this.pipeline.feed(chunk);
    } catch (err) {
      this._reportError(err);
      return;
    }
    if (!frames || frames.length === 0) return;

    const now = Date.now();
    for (const f of frames) {
      this.metrics.onFrameSent(f.level);
      if (this.onFrame) {
        try {
          this.onFrame({
            ts: now,
            ...f,
          });
        } catch (err) {
          this._reportError(err);
        }
      }
    }
  }

  _reportError(err) {
    if (this.metrics) {
      this.metrics.errors.push(String((err && err.message) || err));
      if (this.metrics.errors.length > 5) this.metrics.errors.shift();
    }
    if (this.onError) {
      try { this.onError(err); } catch (_) { /* ignore */ }
    }
  }

  stop() {
    this.running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.capture) {
      try { this.capture.stop(); } catch (_) { /* best effort */ }
      this.capture = null;
    }
    this.rawQueue = [];
    this.metrics.endCapture();
    // Emit any tail frames from the pipeline (e.g. just-ended phrase).
    if (this.pipeline) {
      const tail = this.pipeline.flush();
      for (const f of tail) {
        if (this.onFrame) {
          try { this.onFrame({ ts: Date.now(), ...f }); } catch (_) { }
        }
      }
      this.pipeline = null;
    }
  }

  snapshot() {
    return {
      running: this.running,
      source: this.source,
      sampleRate: this.sampleRate,
      metrics: this.metrics.snapshot(),
    };
  }
}

// --- AudioSourceManager --------------------------------------------------
// Discovers capturable audio sources: the system loopback + audible apps
// (Chrome/Edge/Teams/Zoom/Spotify/etc.) so the UI can pick a process source.
const KNOWN_AUDIO_APPS = [
  'chrome', 'msedge', 'teams', 'zoom', 'brave', 'opera', 'firefox',
  'slack', 'discord', 'spotify', 'vlc', 'wmplayer', 'itunes',
  'electron', 'explorer', 'msteams', 'wechat', 'ths',
];

class AudioSourceManager {
  constructor() {
    this.knownApps = KNOWN_AUDIO_APPS;
    this._cache = { list: [], at: 0 };
  }

  // Returns { sources: [...], defaultSource }
  async enumerateSources(force = false) {
    const now = Date.now();
    if (!force && this._cache.list.length && now - this._cache.at < 8000) {
      return { sources: this._cache.list, defaultSource: this._cache.list[0] || null };
    }
    const list = [];
    list.push({
      pid: null,
      name: 'System Output (Default device)',
      kind: 'system',
      isSystem: true,
    });
    try {
      const procs = await this._listAudioProcesses();
      for (const p of procs) {
        list.push({
          pid: p.pid,
          name: p.title || p.processName || `PID ${p.pid}`,
          kind: 'process',
        });
      }
    } catch (err) {
      // Non-fatal; system source still available.
    }
    this._cache = { list, at: now };
    return { sources: list, defaultSource: list[0] || null };
  }

  _listAudioProcesses() {
    return new Promise((resolve) => {
      const script = `
$known = @($(${this.knownApps.map(s => `'${s}'`).join(', ')}));
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne 0 -and ($_.MainWindowTitle -or ($known -contains $_.ProcessName)) };
$procs | Sort-Object ProcessName | Select-Object -Unique -Property Id, ProcessName, @{N='Title';E={$_.MainWindowTitle}} | ConvertTo-Json -Compress
`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timeout = setTimeout(() => child.kill(), 5000);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', () => { clearTimeout(timeout); resolve([]); });
      child.on('close', () => {
        clearTimeout(timeout);
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
}

module.exports = { WindowsAudioCapture, AudioSourceManager };