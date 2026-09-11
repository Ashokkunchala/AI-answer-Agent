// AudioStatus - Microphone status display with level meter
import { Component } from './Component.js';

export class AudioStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { micActive: false, deviceName: 'No mic', level: 0, sttConnected: false };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'audio-status';
    this.el.innerHTML = `
      <div class="audio-status-row">
        <span class="audio-status-dot" id="asDot"></span>
        <span class="audio-status-device" id="asDevice">${this.state.deviceName}</span>
        <span class="audio-status-stt" id="asStt">STT: --</span>
      </div>
      <div class="audio-status-meter">
        <div class="audio-status-meter-fill" id="asMeter"></div>
      </div>
    `;
    this._applyStyles();
    return this.el;
  }

  onUpdate(state) {
    if (state.micActive !== undefined) {
      const dot = this.$('#asDot');
      dot.style.background = state.micActive ? '#22c55e' : '#ef4444';
      this.el.classList.toggle('active', state.micActive);
    }
    if (state.deviceName) this.$('#asDevice').textContent = state.deviceName;
    if (state.sttConnected !== undefined) {
      this.$('#asStt').textContent = `STT: ${state.sttConnected ? 'Connected' : 'Disconnected'}`;
      this.$('#asStt').style.color = state.sttConnected ? '#22c55e' : '#ef4444';
    }
    if (state.level !== undefined) {
      this.$('#asMeter').style.width = `${Math.min(100, state.level * 100)}%`;
    }
  }

  _applyStyles() {
    if (document.getElementById('audio-status-styles')) return;
    const s = document.createElement('style');
    s.id = 'audio-status-styles';
    s.textContent = `
      .audio-status { padding:8px 12px; background:var(--input,#111827); border-radius:8px; }
      .audio-status-row { display:flex; align-items:center; gap:6px; font-size:.78em; }
      .audio-status-dot { width:7px; height:7px; border-radius:50%; background:#ef4444; flex-shrink:0; }
      .audio-status-device { color:var(--text,#e2e8f0); flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .audio-status-stt { color:var(--text2,#64748b); flex-shrink:0; }
      .audio-status-meter { height:3px; background:var(--border,#1e2a3a); border-radius:2px; margin-top:6px; overflow:hidden; }
      .audio-status-meter-fill { height:100%; width:0%; background:linear-gradient(90deg,#22c55e,#eab308,#ef4444); border-radius:2px; transition:width .05s; }
    `;
    document.head.appendChild(s);
  }
}
