// AnswerModeSelector - Toggle between streaming/instant/batch answer modes
import { Component } from './Component.js';

const ANSWER_MODES = [
  { id: 'stream', label: 'Stream', icon: '&#9889;', desc: 'Real-time streaming' },
  { id: 'instant', label: 'Instant', icon: '&#9889;', desc: 'Full response at once' },
  { id: 'batch', label: 'Batch', icon: '&#128203;', desc: 'Queue and process' },
];

export class AnswerModeSelector extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { active: options.active || 'stream', modes: ANSWER_MODES };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'answer-mode-selector';
    this.el.innerHTML = this.state.modes.map(m =>
      `<button class="ams-btn${m.id === this.state.active ? ' active' : ''}" data-mode="${m.id}" title="${m.desc}">
        <span>${m.icon}</span> ${m.label}
      </button>`
    ).join('');
    this._applyStyles();
    this.el.querySelectorAll('.ams-btn').forEach(btn => {
      this.on(btn, 'click', () => {
        this.state.active = btn.dataset.mode;
        this.el.querySelectorAll('.ams-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === this.state.active));
        this.emit('answer-mode-change', this.state.active);
      });
    });
    return this.el;
  }

  _applyStyles() {
    if (document.getElementById('ams-styles')) return;
    const s = document.createElement('style');
    s.id = 'ams-styles';
    s.textContent = `
      .answer-mode-selector { display:flex; gap:4px; }
      .ams-btn { padding:4px 10px; border:1px solid var(--border,#1e2a3a); background:transparent; color:var(--text2,#64748b); border-radius:6px; cursor:pointer; font-size:.72em; transition:all .15s; }
      .ams-btn:hover { border-color:var(--accent2,#a78bfa); }
      .ams-btn.active { background:var(--accent2,#7c5cfc); color:#fff; border-color:var(--accent2); }
    `;
    document.head.appendChild(s);
  }
}
