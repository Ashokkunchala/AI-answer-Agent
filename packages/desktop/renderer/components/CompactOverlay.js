// CompactOverlay - Mini floating overlay with mic button and status
import { Component } from './Component.js';

export class CompactOverlay extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { micActive: false, status: 'idle', statusText: 'Ready' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'compact-overlay';
    this.el.innerHTML = `
      <div class="co-drag" data-drag="true">
        <button class="co-mic-btn" id="coMic" title="Toggle Microphone">
          <span class="co-mic-icon" id="coMicIcon">&#127908;</span>
        </button>
        <div class="co-info">
          <span class="co-status-text" id="coStatus">${this.state.statusText}</span>
          <div class="co-mini-meter">
            <div class="co-mini-meter-fill" id="coMeter"></div>
          </div>
        </div>
        <button class="co-expand-btn" id="coExpand" title="Expand">&#10133;</button>
      </div>
    `;
    this._applyStyles();
    this._bindEvents();
    return this.el;
  }

  _bindEvents() {
    this.on(this.$('#coMic'), 'click', () => {
      this.state.micActive = !this.state.micActive;
      this.$('#coMic').classList.toggle('active', this.state.micActive);
      this.$('#coMicIcon').innerHTML = this.state.micActive ? '&#127908;' : '&#128263;';
      this.emit('compact-mic-toggle', this.state.micActive);
    });
    this.on(this.$('#coExpand'), 'click', () => this.emit('compact-expand'));
  }

  onUpdate(state) {
    if (state.statusText) this.$('#coStatus').textContent = state.statusText;
    if (state.level !== undefined) {
      this.$('#coMeter').style.width = `${Math.min(100, state.level * 100)}%`;
    }
    if (state.micActive !== undefined) {
      this.$('#coMic').classList.toggle('active', state.micActive);
      this.$('#coMicIcon').innerHTML = state.micActive ? '&#127908;' : '&#128263;';
    }
  }

  _applyStyles() {
    if (document.getElementById('co-styles')) return;
    const s = document.createElement('style');
    s.id = 'co-styles';
    s.textContent = `
      .compact-overlay { position:fixed; top:12px; right:12px; z-index:9999; }
      .co-drag { display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--overlay-bg,rgba(10,10,20,0.95)); border:1px solid var(--border,#1e2a3a); border-radius:12px; backdrop-filter:blur(12px); box-shadow:0 4px 20px rgba(0,0,0,0.4); -webkit-app-region:drag; }
      .co-mic-btn { width:36px; height:36px; border:none; background:var(--input,#111827); color:var(--text,#e2e8f0); border-radius:50%; cursor:pointer; font-size:1.1em; display:flex; align-items:center; justify-content:center; transition:all .2s; -webkit-app-region:no-drag; }
      .co-mic-btn.active { background:#22c55e; color:#fff; box-shadow:0 0 12px #22c55e44; }
      .co-mic-btn:hover { transform:scale(1.05); }
      .co-info { display:flex; flex-direction:column; gap:2px; min-width:60px; -webkit-app-region:no-drag; }
      .co-status-text { font-size:.72em; color:var(--text2,#64748b); white-space:nowrap; }
      .co-mini-meter { height:2px; background:var(--border,#1e2a3a); border-radius:1px; overflow:hidden; }
      .co-mini-meter-fill { height:100%; width:0%; background:#22c55e; transition:width .05s; }
      .co-expand-btn { width:28px; height:28px; border:none; background:transparent; color:var(--text2,#64748b); border-radius:8px; cursor:pointer; font-size:.9em; display:flex; align-items:center; justify-content:center; -webkit-app-region:no-drag; transition:all .15s; }
      .co-expand-btn:hover { background:var(--hover,#1a2332); color:var(--text,#e2e8f0); }
    `;
    document.head.appendChild(s);
  }
}
