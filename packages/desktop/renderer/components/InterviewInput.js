// InterviewInput - Multi-line input with send button
import { Component } from './Component.js';

export class InterviewInput extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { placeholder: options.placeholder || 'Type your question...', sending: false };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'interview-input';
    this.el.innerHTML = `
      <textarea class="ii-textarea" id="iiTextarea" placeholder="${this.state.placeholder}" rows="1" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
      <button class="ii-send" id="iiSend" title="Send (Enter)">&#10148;</button>
    `;
    this._applyStyles();
    const textarea = this.$('#iiTextarea');
    const sendBtn = this.$('#iiSend');

    this.on(textarea, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this._send();
      }
    });
    this.on(textarea, 'input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });
    this.on(sendBtn, 'click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._send();
    });
    
    // Focus textarea when clicked anywhere on the component
    this.on(this.el, 'click', () => {
      textarea.focus();
    });
    
    return this.el;
  }

  _send() {
    const textarea = this.$('#iiTextarea');
    const text = textarea.value.trim();
    if (!text || this.state.sending) return;
    this.emit('input-send', { text });
    textarea.value = '';
    textarea.style.height = 'auto';
  }

  getValue() { return this.$('#iiTextarea')?.value || ''; }
  setValue(v) { const t = this.$('#iiTextarea'); if (t) t.value = v; }
  setSending(s) { this.state.sending = s; this.$('#iiSend').disabled = s; }

  _applyStyles() {
    if (document.getElementById('ii-styles')) return;
    const s = document.createElement('style');
    s.id = 'ii-styles';
    s.textContent = `
      .interview-input { display:flex; gap:8px; padding:8px 12px; border-top:1px solid var(--border,#1e2a3a); background:var(--sidebar,#0d1117); align-items:flex-end; }
      .ii-textarea { flex:1; resize:none; min-height:36px; max-height:120px; padding:8px 12px; background:var(--input,#111827); border:1px solid var(--border,#1e2a3a); color:var(--text,#e2e8f0); border-radius:8px; font-family:inherit; font-size:.85em; outline:none; line-height:1.4; user-select:text; cursor:text; -webkit-user-select:text; }
      .ii-textarea:focus { border-color:var(--accent2,#7c5cfc); box-shadow:0 0 0 2px rgba(124,92,252,0.2); }
      .ii-textarea::placeholder { color:var(--text2,#64748b); }
      .ii-send { width:36px; height:36px; border:none; background:var(--accent2,#7c5cfc); color:#fff; border-radius:8px; cursor:pointer; font-size:1em; display:flex; align-items:center; justify-content:center; transition:all .15s; flex-shrink:0; }
      .ii-send:hover { opacity:.85; transform:scale(1.05); }
      .ii-send:active { transform:scale(0.95); }
      .ii-send:disabled { opacity:.4; cursor:not-allowed; transform:none; }
    `;
    document.head.appendChild(s);
  }
}
