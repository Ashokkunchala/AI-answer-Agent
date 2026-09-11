// ContextStatus - Shows resume/job context loaded status
import { Component } from './Component.js';

export class ContextStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { hasResume: false, hasJobDesc: false, targetName: '', participants: [] };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'context-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const items = [];
    if (this.state.hasResume) items.push('<span class="cs-item cs-active">&#128196; Resume</span>');
    if (this.state.hasJobDesc) items.push('<span class="cs-item cs-active">&#128188; Job Desc</span>');
    if (this.state.targetName) items.push(`<span class="cs-item">&#128100; ${this._esc(this.state.targetName)}</span>`);
    if (this.state.participants.length) items.push(`<span class="cs-item">&#128101; ${this.state.participants.length}</span>`);
    if (items.length === 0) items.push('<span class="cs-item cs-empty">No context loaded</span>');
    this.el.innerHTML = items.join('');
  }

  _esc(s) { return String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  _applyStyles() {
    if (document.getElementById('cs-styles')) return;
    const s = document.createElement('style');
    s.id = 'cs-styles';
    s.textContent = `
      .context-status { display:flex; gap:6px; flex-wrap:wrap; padding:4px 0; }
      .cs-item { font-size:.72em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); color:var(--text2,#64748b); }
      .cs-item.cs-active { color:var(--green,#22c55e); }
      .cs-item.cs-empty { font-style:italic; }
    `;
    document.head.appendChild(s);
  }
}
