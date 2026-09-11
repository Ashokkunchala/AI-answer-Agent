// VADIndicator - Voice Activity Detection visual indicator
import { Component } from './Component.js';

export class VADIndicator extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { speaking: false, level: 0, threshold: 0.015 };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'vad-indicator';
    this.el.innerHTML = `
      <div class="vad-ring" id="vadRing">
        <div class="vad-ring-inner"></div>
      </div>
      <span class="vad-label" id="vadLabel">VAD</span>
    `;
    this._applyStyles();
    return this.el;
  }

  onUpdate(state) {
    if (state.speaking !== undefined) {
      this.el.classList.toggle('speaking', state.speaking);
    }
    if (state.level !== undefined) {
      const scale = 1 + state.level * 0.5;
      this.$('#vadRing').style.transform = `scale(${scale})`;
    }
  }

  _applyStyles() {
    if (document.getElementById('vad-styles')) return;
    const s = document.createElement('style');
    s.id = 'vad-styles';
    s.textContent = `
      .vad-indicator { display:flex; align-items:center; gap:6px; }
      .vad-ring { width:24px; height:24px; border-radius:50%; border:2px solid var(--text2,#64748b); display:flex; align-items:center; justify-content:center; transition:all .15s; }
      .vad-indicator.speaking .vad-ring { border-color:#22c55e; background:#22c55e22; }
      .vad-ring-inner { width:8px; height:8px; border-radius:50%; background:var(--text2,#64748b); transition:all .15s; }
      .vad-indicator.speaking .vad-ring-inner { background:#22c55e; }
      .vad-label { font-size:.7em; color:var(--text2,#64748b); }
    `;
    document.head.appendChild(s);
  }
}
