// CollapsedOverlay - Tiny floating pill for quick mic toggle
import { Component } from './Component.js';

export class CollapsedOverlay extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { micActive: false, status: 'idle' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'collapsed-overlay';
    this.el.innerHTML = `
      <div class="col-drag" data-drag="true">
        <button class="col-mic-btn" id="colMic" title="Toggle Microphone">
          <span id="colMicIcon">&#127908;</span>
        </button>
        <button class="col-expand-btn" id="colExpand" title="Expand" style="display:none">&#9654;</button>
      </div>
    `;
    this._applyStyles();
    this._bindEvents();
    return this.el;
  }

  _bindEvents() {
    this.on(this.$('#colMic'), 'click', () => {
      this.state.micActive = !this.state.micActive;
      this._updateMic();
      this.emit('collapsed-mic-toggle', this.state.micActive);
    });
    this.on(this.$('#colExpand'), 'click', () => this.emit('collapsed-expand'));
    // Hover to show expand button
    this.on(this.el, 'mouseenter', () => { this.$('#colExpand').style.display = 'flex'; });
    this.on(this.el, 'mouseleave', () => { this.$('#colExpand').style.display = 'none'; });
  }

  _updateMic() {
    const btn = this.$('#colMic');
    const icon = this.$('#colMicIcon');
    btn.classList.toggle('active', this.state.micActive);
    icon.innerHTML = this.state.micActive ? '&#127908;' : '&#128263;';
  }

  onUpdate(state) {
    if (state.micActive !== undefined) {
      this.state.micActive = state.micActive;
      this._updateMic();
    }
  }

  _applyStyles() {
    if (document.getElementById('col-styles')) return;
    const s = document.createElement('style');
    s.id = 'col-styles';
    s.textContent = `
      .collapsed-overlay { position:fixed; top:12px; right:12px; z-index:9999; }
      .col-drag { display:flex; align-items:center; gap:0; padding:4px; background:var(--overlay-bg,rgba(10,10,20,0.95)); border:1px solid var(--border,#1e2a3a); border-radius:20px; backdrop-filter:blur(12px); box-shadow:0 4px 20px rgba(0,0,0,0.4); -webkit-app-region:drag; }
      .col-mic-btn { width:32px; height:32px; border:none; background:transparent; color:var(--text,#e2e8f0); border-radius:50%; cursor:pointer; font-size:.95em; display:flex; align-items:center; justify-content:center; transition:all .2s; -webkit-app-region:no-drag; }
      .col-mic-btn.active { background:#22c55e; color:#fff; }
      .col-mic-btn:hover { transform:scale(1.05); }
      .col-expand-btn { width:24px; height:24px; border:none; background:transparent; color:var(--text2,#64748b); border-radius:50%; cursor:pointer; font-size:.7em; display:flex; align-items:center; justify-content:center; -webkit-app-region:no-drag; transition:all .15s; }
      .col-expand-btn:hover { background:var(--hover,#1a2332); color:var(--text,#e2e8f0); }
    `;
    document.head.appendChild(s);
  }
}
