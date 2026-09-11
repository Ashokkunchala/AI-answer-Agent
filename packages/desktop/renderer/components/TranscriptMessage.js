// TranscriptMessage - Single transcript message (final or interim)
import { Component } from './Component.js';

export class TranscriptMessage extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { text: options.text || '', type: options.type || 'final', timestamp: Date.now() };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = `transcript-msg transcript-msg-${this.state.type}`;
    const time = new Date(this.state.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.el.innerHTML = `
      <span class="tm-time">${time}</span>
      <span class="tm-text">${this._escapeHtml(this.state.text)}</span>
    `;
    this._applyStyles();
    return this.el;
  }

  _escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  _applyStyles() {
    if (document.getElementById('tm-styles')) return;
    const s = document.createElement('style');
    s.id = 'tm-styles';
    s.textContent = `
      .transcript-msg { display:flex; gap:6px; font-size:.82em; padding:3px 8px; border-radius:6px; }
      .transcript-msg-final { color:var(--text,#e2e8f0); }
      .transcript-msg-interim { color:var(--text2,#64748b); font-style:italic; }
      .tm-time { color:var(--text2,#64748b); font-size:.85em; flex-shrink:0; font-family:'SF Mono',monospace; }
      .tm-text { flex:1; word-break:break-word; }
    `;
    document.head.appendChild(s);
  }
}
