// ChatMessage - Single chat message in transcript
import { Component } from './Component.js';

export class ChatMessage extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { role: options.role || 'user', content: options.content || '', timestamp: Date.now(), model: options.model || '' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = `chat-msg chat-msg-${this.state.role}`;
    const time = new Date(this.state.timestamp).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    this.el.innerHTML = `
      <div class="cm-header">
        <span class="cm-role">${this.state.role === 'user' ? '&#128100; You' : '&#129302; AI'}</span>
        ${this.state.model ? `<span class="cm-model">${this._esc(this.state.model)}</span>` : ''}
        <span class="cm-time">${time}</span>
      </div>
      <div class="cm-content">${this._format(this.state.content)}</div>
    `;
    this._applyStyles();
    return this.el;
  }

  _format(text) {
    return this._esc(text)
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code class="cm-inline">$1</code>')
      .replace(/\n/g, '<br>');
  }

  _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  _applyStyles() {
    if (document.getElementById('cm-styles')) return;
    const s = document.createElement('style');
    s.id = 'cm-styles';
    s.textContent = `
      .chat-msg { padding:8px 12px; border-radius:8px; }
      .chat-msg-user { background:rgba(124,92,252,0.07); }
      .chat-msg-assistant { background:transparent; }
      .cm-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:.72em; }
      .cm-role { color:var(--text2,#64748b); font-weight:600; }
      .cm-model { color:var(--accent2,#a78bfa); font-family:'SF Mono',monospace; }
      .cm-time { color:var(--text2,#64748b); margin-left:auto; }
      .cm-content { font-size:.85em; color:var(--text,#e2e8f0); line-height:1.6; word-break:break-word; }
      .cm-content pre { background:var(--input,#111827); padding:10px; border-radius:6px; overflow-x:auto; margin:6px 0; font-size:.85em; }
      .cm-content code.cm-inline { background:var(--input,#111827); padding:1px 5px; border-radius:4px; font-size:.85em; }
    `;
    document.head.appendChild(s);
  }
}
