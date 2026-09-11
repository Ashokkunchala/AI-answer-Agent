// ModelInfo - Current AI model being used
import { Component } from './Component.js';

export class ModelInfo extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { model: 'auto', provider: '', latency: null, fallback: false };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'model-info';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const { model, provider, latency, fallback } = this.state;
    this.el.innerHTML = `
      <span class="mi-model">${this._esc(model)}</span>
      ${provider ? `<span class="mi-provider">${this._esc(provider)}</span>` : ''}
      ${latency ? `<span class="mi-latency">${latency}ms</span>` : ''}
      ${fallback ? '<span class="mi-fallback">fallback</span>' : ''}
    `;
  }

  _esc(s) { return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  _applyStyles() {
    if (document.getElementById('mi-styles')) return;
    const s = document.createElement('style');
    s.id = 'mi-styles';
    s.textContent = `
      .model-info { display:inline-flex; align-items:center; gap:5px; font-size:.72em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); color:var(--text2,#64748b); }
      .mi-model { color:var(--accent2,#a78bfa); font-family:'SF Mono',monospace; }
      .mi-provider { color:var(--text2,#64748b); }
      .mi-latency { color:var(--green,#22c55e); font-family:'SF Mono',monospace; }
      .mi-fallback { color:var(--yellow,#eab308); font-style:italic; }
    `;
    document.head.appendChild(s);
  }
}
