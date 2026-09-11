// ConnectionStatus - API connection indicator
import { Component } from './Component.js';

export class ConnectionStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { connected: false, url: '', latency: null };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'connection-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const { connected, latency } = this.state;
    this.el.innerHTML = `
      <span class="cs-dot" style="background:${connected ? '#22c55e' : '#ef4444'}"></span>
      <span class="cs-text">${connected ? 'Connected' : 'Disconnected'}</span>
      ${latency ? `<span class="cs-latency">${latency}ms</span>` : ''}
    `;
    this.el.classList.toggle('connected', connected);
  }

  _applyStyles() {
    if (document.getElementById('conn-styles')) return;
    const s = document.createElement('style');
    s.id = 'conn-styles';
    s.textContent = `
      .connection-status { display:inline-flex; align-items:center; gap:5px; font-size:.75em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); }
      .cs-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
      .cs-text { color:var(--text2,#64748b); }
      .connection-status.connected .cs-text { color:var(--green,#22c55e); }
      .cs-latency { color:var(--text2,#64748b); font-family:'SF Mono',monospace; }
    `;
    document.head.appendChild(s);
  }
}
