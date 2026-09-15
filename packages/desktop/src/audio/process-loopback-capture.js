// process-loopback-capture.js — WASAPI process-scoped loopback capture.
//
// Uses the addon's process-loopback virtual device (Windows 10 2004+):
// captures audio rendered by one process and, optionally, its child
// process tree. Monitors the target process; if it exits the parent is
// notified so the service can re-select or fall back.
'use strict';

const LoopbackCapture = require('loopback-capture').LoopbackCapture;
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

function isProcessAlive(pid) {
  return new Promise((resolve) => {
    if (!pid || !Number.isInteger(pid)) return resolve(false);
    const child = spawn('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH'], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* */ } }, 3000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.toLowerCase().includes((pid).toString()) && out.toLowerCase().includes('exe'));
    });
  });
}

class ProcessLoopbackCapture extends EventEmitter {
  constructor(options = {}) {
    super();
    this.pid = options.pid || 0;
    this.includeTree = options.includeTree !== false;
    this.monitorMs = options.monitorMs || 1500;
    this.label = options.label || ('process-loopback:' + this.pid);
    this._capture = null;
    this.running = false;
    this.startedAt = null;
    this.byteCount = 0;
    this._monitor = null;
  }

  get isRunning() { return this.running; }

  start() {
    if (this.running) return { ok: true, error: 'already-running' };
    if (!this.pid || !Number.isInteger(this.pid)) {
      const err = new Error('Process loopback requires a valid pid');
      this.emit('error', err);
      return { ok: false, error: err.message };
    }
    const cap = new LoopbackCapture();
    const onChunk = (chunk) => {
      if (!this.running) return;
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
      this.byteCount += chunk.byteLength;
      this.emit('chunk', chunk);
    };
    try {
      cap.start(this.pid, this.includeTree, onChunk);
      this._capture = cap;
      this.running = true;
      this.startedAt = Date.now();
      this._startMonitor();
      this.emit('started');
      return { ok: true, error: null };
    } catch (err) {
      this.emit('error', err);
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  _startMonitor() {
    this._monitor = setInterval(() => {
      if (!this.running) return;
      isProcessAlive(this.pid).then((alive) => {
        if (!alive && this.running) {
          this.running = false;
          this.emit('process-exit', this.pid);
        }
      });
    }, this.monitorMs);
    if (this._monitor.unref) this._monitor.unref();
  }

  restart(pid) {
    if (pid) this.pid = pid;
    this.stop();
    return this.start();
  }

  stop() {
    if (this._monitor) { clearInterval(this._monitor); this._monitor = null; }
    if (!this.running && !this._capture) return;
    this.running = false;
    const cap = this._capture;
    this._capture = null;
    if (cap) {
      try { cap.stop(); } catch (_) { /* best effort */ }
    }
    this.emit('stopped');
  }

  snapshot() {
    return {
      pid: this.pid,
      includeTree: this.includeTree,
      running: this.running,
      startedAt: this.startedAt,
      bytes: this.byteCount,
    };
  }
}

module.exports = { ProcessLoopbackCapture, isProcessAlive };