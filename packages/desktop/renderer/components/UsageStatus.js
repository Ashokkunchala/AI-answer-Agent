// UsageStatus - Token/request usage display
import { Component } from './Component.js';

export class UsageStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { requests: 0, tokens: 0, models: {} };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'usage-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    this.el.innerHTML = `
      <span class="us-item" title="Requests">&#128200; ${this.state.requests}</span>
      <span class="us-item" title="Tokens">&#128196; ${this._formatTokens(this.state.tokens)}</span>
    `;
  }

  _formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  _applyStyles() {
    if (document.getElementById('us-styles')) return;
    const s = document.createElement('style');
    s.id = 'us-styles';
    s.textContent = `
      .usage-status { display:flex; gap:10px; font-size:.72em; color:var(--text2,#64748b); }
      .us-item { display:flex; align-items:center; gap:3px; }
    `;
    document.head.appendChild(s);
  }
}
