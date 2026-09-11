// ScreenWatcherStatus - Screen watching status indicator
import { Component } from './Component.js';

export class ScreenWatcherStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { active: false, interval: 10, lastCapture: null, lastAnalysis: '' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'screen-watcher-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const { active, interval, lastCapture } = this.state;
    const time = lastCapture ? new Date(lastCapture).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '--';
    this.el.innerHTML = `
      <span class="sws-dot" style="background:${active ? '#22c55e' : '#64748b'}"></span>
      <span class="sws-text">Screen: ${active ? 'Watching' : 'Off'}</span>
      ${active ? `<span class="sws-interval">${interval}s</span>` : ''}
      ${active ? `<span class="sws-time">${time}</span>` : ''}
    `;
    this.el.classList.toggle('active', active);
  }

  _applyStyles() {
    if (document.getElementById('sws-styles')) return;
    const s = document.createElement('style');
    s.id = 'sws-styles';
    s.textContent = `
      .screen-watcher-status { display:inline-flex; align-items:center; gap:5px; font-size:.75em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); color:var(--text2,#64748b); }
      .screen-watcher-status.active { color:var(--green,#22c55e); }
      .sws-dot { width:6px; height:6px; border-radius:50%; }
      .sws-interval { padding:1px 5px; background:var(--card,#151b27); border-radius:4px; font-size:.85em; font-family:'SF Mono',monospace; }
      .sws-time { font-family:'SF Mono',monospace; font-size:.85em; }
    `;
    document.head.appendChild(s);
  }
}
