// AIAnswerPanel - Container for AI-generated answer cards
import { Component } from './Component.js';

export class AIAnswerPanel extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { answers: [], loading: false };
    this._answerEls = [];
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ai-answer-panel';
    this.el.innerHTML = `
      <div class="aap-empty" id="aapEmpty">
        <div class="aap-empty-icon">&#9889;</div>
        <p>Ask a question or enable screen watching</p>
      </div>
      <div class="aap-answers" id="aapAnswers"></div>
      <div class="aap-loading" id="aapLoading" style="display:none">
        <div class="aap-spinner"></div>
        <span>Thinking...</span>
      </div>
    `;
    this._applyStyles();
    return this.el;
  }

  addAnswer(data) {
    this.$('#aapEmpty').style.display = 'none';
    const card = document.createElement('div');
    card.className = 'aap-card';
    card.innerHTML = `
      <div class="aap-card-header">
        <span class="aap-card-question">${this._escapeHtml(data.question || '')}</span>
        <span class="aap-card-meta">${data.model || ''} ${data.latency ? data.latency + 'ms' : ''}</span>
      </div>
      <div class="aap-card-answer">${this._formatAnswer(data.answer || '')}</div>
      <div class="aap-card-actions">
        <button class="aap-action" data-action="copy" title="Copy">&#128203; Copy</button>
        <button class="aap-action" data-action="save" title="Save">&#128190; Save</button>
      </div>
    `;
    this.on(card.querySelector('[data-action="copy"]'), 'click', () => {
      navigator.clipboard.writeText(data.answer || '');
      this.emit('answer-copy', data);
    });
    this.on(card.querySelector('[data-action="save"]'), 'click', () => {
      this.emit('answer-save', data);
    });
    this.$('#aapAnswers').prepend(card);
    this._answerEls.push(card);
    // Keep max 20 answers
    while (this._answerEls.length > 20) {
      const old = this._answerEls.shift();
      old.remove();
    }
  }

  updateLastAnswer(text) {
    const last = this.$('#aapAnswers').firstElementChild;
    if (last) {
      const answerEl = last.querySelector('.aap-card-answer');
      if (answerEl) answerEl.innerHTML = this._formatAnswer(text);
    }
  }

  updateCardMeta({ model, latency }) {
    const last = this.$('#aapAnswers').firstElementChild;
    if (last) {
      const metaEl = last.querySelector('.aap-card-meta');
      if (metaEl) {
        const parts = [];
        if (model) parts.push(model);
        if (latency) parts.push(latency + 'ms');
        metaEl.textContent = parts.join(' ');
      }
    }
  }

  setLoading(loading) {
    this.state.loading = loading;
    this.$('#aapLoading').style.display = loading ? 'flex' : 'none';
  }

  clear() {
    this._answerEls.forEach(el => el.remove());
    this._answerEls = [];
    this.$('#aapEmpty').style.display = '';
    this.$('#aapAnswers').innerHTML = '';
  }

  _formatAnswer(text) {
    return text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
               .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
               .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
               .replace(/\n/g, '<br>');
  }

  _escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  _applyStyles() {
    if (document.getElementById('aap-styles')) return;
    const s = document.createElement('style');
    s.id = 'aap-styles';
    s.textContent = `
      .ai-answer-panel { display:flex; flex-direction:column; gap:8px; padding:8px 12px; }
      .aap-empty { text-align:center; padding:30px 20px; color:var(--text2,#64748b); }
      .aap-empty-icon { font-size:2em; margin-bottom:8px; }
      .aap-card { background:var(--card,#151b27); border:1px solid var(--border,#1e2a3a); border-radius:10px; padding:12px; animation:fadeIn .2s; }
      .aap-card-header { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; margin-bottom:8px; }
      .aap-card-question { font-size:.82em; color:var(--accent2,#a78bfa); font-weight:600; }
      .aap-card-meta { font-size:.7em; color:var(--text2,#64748b); flex-shrink:0; }
      .aap-card-answer { font-size:.85em; color:var(--text,#e2e8f0); line-height:1.6; word-break:break-word; }
      .aap-card-answer pre { background:var(--input,#111827); padding:10px; border-radius:6px; overflow-x:auto; margin:8px 0; font-size:.85em; }
      .aap-card-answer code.inline { background:var(--input,#111827); padding:1px 5px; border-radius:4px; font-size:.85em; }
      .aap-card-actions { display:flex; gap:6px; margin-top:8px; }
      .aap-action { padding:4px 10px; border:1px solid var(--border,#1e2a3a); background:transparent; color:var(--text2,#64748b); border-radius:6px; cursor:pointer; font-size:.75em; transition:all .15s; }
      .aap-action:hover { border-color:var(--accent2,#a78bfa); color:var(--accent2); }
      .aap-loading { display:flex; align-items:center; justify-content:center; gap:8px; padding:16px; color:var(--text2,#64748b); font-size:.85em; }
      .aap-spinner { width:16px; height:16px; border:2px solid var(--border,#1e2a3a); border-top-color:var(--accent2,#a78bfa); border-radius:50%; animation:spin .6s linear infinite; }
      @keyframes spin { to { transform:rotate(360deg); } }
    `;
    document.head.appendChild(s);
  }
}
