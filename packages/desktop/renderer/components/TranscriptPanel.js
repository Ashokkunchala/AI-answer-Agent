// TranscriptPanel - Live transcript display with final/interim messages
import { Component } from './Component.js';
import { TranscriptMessage } from './TranscriptMessage.js';

export class TranscriptPanel extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { messages: [], interim: '', visible: false };
    this._messages = [];
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'transcript-panel';
    this.el.innerHTML = `
      <div class="tp-header">
        <span class="tp-label">Live Transcript</span>
        <span class="tp-badge" id="tpBadge"></span>
      </div>
      <div class="tp-body" id="tpBody">
        <div class="tp-empty">Waiting for speech...</div>
      </div>
    `;
    this._applyStyles();
    return this.el;
  }

  addMessage(text, type = 'final') {
    const msg = new TranscriptMessage(this.$('#tpBody'), { text, type });
    msg.render();
    msg.mount();
    this._messages.push(msg);
    // Keep only last 50 messages
    if (this._messages.length > 50) {
      const old = this._messages.shift();
      old.destroy();
    }
    this._scrollToBottom();
  }

  setInterim(text) {
    let interim = this.$('.tp-interim');
    if (!interim) {
      interim = document.createElement('div');
      interim.className = 'tp-interim';
      this.$('#tpBody').appendChild(interim);
    }
    interim.textContent = text;
    if (!text) interim.remove();
    this._scrollToBottom();
  }

  clear() {
    this._messages.forEach(m => m.destroy());
    this._messages = [];
    const body = this.$('#tpBody');
    body.innerHTML = '<div class="tp-empty">Waiting for speech...</div>';
  }

  _scrollToBottom() {
    const body = this.$('#tpBody');
    body.scrollTop = body.scrollHeight;
  }

  _applyStyles() {
    if (document.getElementById('tp-styles')) return;
    const s = document.createElement('style');
    s.id = 'tp-styles';
    s.textContent = `
      .transcript-panel { display:flex; flex-direction:column; }
      .tp-header { display:flex; align-items:center; justify-content:space-between; padding:6px 12px; font-size:.75em; }
      .tp-label { color:var(--text2,#64748b); font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
      .tp-badge { padding:2px 8px; border-radius:6px; font-size:.85em; background:var(--input,#111827); color:var(--text2); }
      .tp-body { max-height:200px; overflow-y:auto; padding:8px 12px; display:flex; flex-direction:column; gap:6px; }
      .tp-empty { color:var(--text2,#64748b); font-size:.82em; font-style:italic; text-align:center; padding:12px; }
      .tp-interim { color:var(--text2,#64748b); font-size:.85em; font-style:italic; padding:4px 8px; border-left:2px solid var(--border,#1e2a3a); }
    `;
    document.head.appendChild(s);
  }
}
