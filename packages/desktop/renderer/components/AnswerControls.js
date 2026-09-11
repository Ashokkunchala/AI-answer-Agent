// AnswerControls - Copy/Save/Share actions for an answer
import { Component } from './Component.js';

export class AnswerControls extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { answer: options.answer || '' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'answer-controls';
    this.el.innerHTML = `
      <button class="ac-btn" data-action="copy" title="Copy to clipboard">&#128203; Copy</button>
      <button class="ac-btn" data-action="save" title="Save to snippets">&#128190; Save</button>
      <button class="ac-btn" data-action="share" title="Share">&#128279; Share</button>
    `;
    this._applyStyles();
    this.el.querySelectorAll('.ac-btn').forEach(btn => {
      this.on(btn, 'click', () => this.emit('answer-action', { action: btn.dataset.action, answer: this.state.answer }));
    });
    return this.el;
  }

  _applyStyles() {
    if (document.getElementById('ac-styles')) return;
    const s = document.createElement('style');
    s.id = 'ac-styles';
    s.textContent = `
      .answer-controls { display:flex; gap:6px; }
      .ac-btn { padding:5px 12px; border:1px solid var(--border,#1e2a3a); background:transparent; color:var(--text2,#64748b); border-radius:6px; cursor:pointer; font-size:.78em; transition:all .15s; white-space:nowrap; }
      .ac-btn:hover { border-color:var(--accent2,#a78bfa); color:var(--accent2); background:rgba(124,92,252,0.07); }
    `;
    document.head.appendChild(s);
  }
}
