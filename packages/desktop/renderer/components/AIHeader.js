// AIHeader - Title bar with drag region, status, and action buttons
import { Component } from './Component.js';

export class AIHeader extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { title: options.title || 'DevOps AI Agent', status: 'ready', statusColor: '#22c55e' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ai-header';
    this.el.innerHTML = `
      <div class="ai-header-drag" data-drag="true">
        <span class="ai-header-icon">&#9889;</span>
        <span class="ai-header-title">${this.state.title}</span>
      </div>
      <div class="ai-header-status">
        <span class="ai-header-dot" style="background:${this.state.statusColor}"></span>
        <span class="ai-header-status-text">${this.state.status}</span>
      </div>
      <div class="ai-header-actions">
        <button class="ai-header-btn" data-action="settings" title="Settings">&#9881;</button>
        <button class="ai-header-btn" data-action="minimize" title="Minimize">&#8722;</button>
        <button class="ai-header-btn ai-header-btn-close" data-action="close" title="Hide">&#10005;</button>
      </div>
    `;
    this._applyStyles();
    this._bindEvents();
    return this.el;
  }

  _bindEvents() {
    this.el.querySelectorAll('[data-action]').forEach(btn => {
      this.on(btn, 'click', () => this.emit('header-action', btn.dataset.action));
    });
  }

  onUpdate(state) {
    if (state.title) this.$('.ai-header-title').textContent = state.title;
    if (state.status) this.$('.ai-header-status-text').textContent = state.status;
    if (state.statusColor) this.$('.ai-header-dot').style.background = state.statusColor;
  }

  _applyStyles() {
    if (document.getElementById('ai-header-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-header-styles';
    style.textContent = `
      .ai-header { display:flex; align-items:center; padding:8px 12px; background:var(--sidebar,#0d1117); border-bottom:1px solid var(--border,#1e2a3a); gap:8px; user-select:none; -webkit-app-region:drag; }
      .ai-header-drag { display:flex; align-items:center; gap:6px; flex:1; min-width:0; }
      .ai-header-icon { font-size:1.1em; }
      .ai-header-title { font-size:.88em; font-weight:600; color:var(--accent2,#a78bfa); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ai-header-status { display:flex; align-items:center; gap:5px; font-size:.72em; color:var(--text2,#64748b); flex-shrink:0; }
      .ai-header-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
      .ai-header-actions { display:flex; gap:2px; -webkit-app-region:no-drag; flex-shrink:0; }
      .ai-header-btn { width:28px; height:28px; border:none; background:transparent; color:var(--text2,#64748b); border-radius:6px; cursor:pointer; font-size:.9em; display:flex; align-items:center; justify-content:center; transition:all .15s; }
      .ai-header-btn:hover { background:var(--hover,#1a2332); color:var(--text,#e2e8f0); }
      .ai-header-btn-close:hover { background:#ef444433; color:#ef4444; }
    `;
    document.head.appendChild(style);
  }
}
