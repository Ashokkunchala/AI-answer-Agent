// SessionTimer - Displays elapsed session time
import { Component } from './Component.js';

export class SessionTimer extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { running: false, startTime: null, elapsed: 0 };
    this._interval = null;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'session-timer';
    this.el.innerHTML = `
      <span class="session-timer-icon">&#9201;</span>
      <span class="session-timer-value">00:00:00</span>
    `;
    this._applyStyles();
    return this.el;
  }

  start() {
    this.state.running = true;
    this.state.startTime = Date.now() - this.state.elapsed;
    this._interval = this.setInterval(() => this._tick(), 1000);
    this.el.classList.add('active');
  }

  stop() {
    this.state.running = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this.el.classList.remove('active');
  }

  reset() {
    this.stop();
    this.state.elapsed = 0;
    this.state.startTime = null;
    this.$('.session-timer-value').textContent = '00:00:00';
  }

  _tick() {
    this.state.elapsed = Date.now() - this.state.startTime;
    this.$('.session-timer-value').textContent = this._format(this.state.elapsed);
  }

  _format(ms) {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
  }

  _applyStyles() {
    if (document.getElementById('session-timer-styles')) return;
    const s = document.createElement('style');
    s.id = 'session-timer-styles';
    s.textContent = `
      .session-timer { display:inline-flex; align-items:center; gap:4px; font-size:.75em; color:var(--text2,#64748b); padding:2px 8px; border-radius:6px; background:var(--input,#111827); }
      .session-timer.active { color:var(--green,#22c55e); }
      .session-timer-icon { font-size:1em; }
    `;
    document.head.appendChild(s);
  }
}
