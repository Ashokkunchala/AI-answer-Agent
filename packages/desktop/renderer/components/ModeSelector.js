// ModeSelector - Switch between Interview, Quick Q&A, Code Gen, Debug modes
import { Component } from './Component.js';

const MODES = [
  { id: 'interview', label: 'Interview', icon: '&#127891;', color: '#8B5CF6' },
  { id: 'quick_qa', label: 'Quick Q&A', icon: '&#10067;', color: '#3B82F6' },
  { id: 'code_gen', label: 'Code', icon: '&#128187;', color: '#22C55E' },
  { id: 'debug', label: 'Debug', icon: '&#128027;', color: '#EF4444' },
  { id: 'review', label: 'Review', icon: '&#128269;', color: '#F59E0B' },
  { id: 'explain', label: 'Explain', icon: '&#128214;', color: '#06B6D4' },
];

export class ModeSelector extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { active: options.active || 'interview', modes: options.modes || MODES };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'mode-selector';
    this.el.innerHTML = this.state.modes.map(m =>
      `<button class="mode-btn${m.id === this.state.active ? ' active' : ''}" data-mode="${m.id}" style="--mode-color:${m.color}">
        <span class="mode-icon">${m.icon}</span>
        <span class="mode-label">${m.label}</span>
      </button>`
    ).join('');
    this._applyStyles();
    this.el.querySelectorAll('.mode-btn').forEach(btn => {
      this.on(btn, 'click', () => {
        this.state.active = btn.dataset.mode;
        this.el.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === this.state.active));
        this.emit('mode-change', this.state.active);
      });
    });
    return this.el;
  }

  onUpdate(state) {
    if (state.active) {
      this.state.active = state.active;
      this.el.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.active));
    }
  }

  _applyStyles() {
    if (document.getElementById('mode-selector-styles')) return;
    const s = document.createElement('style');
    s.id = 'mode-selector-styles';
    s.textContent = `
      .mode-selector { display:flex; gap:4px; padding:4px; background:var(--input,#111827); border-radius:10px; overflow-x:auto; }
      .mode-btn { display:flex; align-items:center; gap:4px; padding:6px 10px; border:none; background:transparent; color:var(--text2,#64748b); border-radius:8px; cursor:pointer; font-size:.78em; white-space:nowrap; transition:all .15s; }
      .mode-btn:hover { background:var(--hover,#1a2332); }
      .mode-btn.active { background:var(--mode-color); color:#fff; font-weight:600; }
      .mode-icon { font-size:1em; }
    `;
    document.head.appendChild(s);
  }
}
