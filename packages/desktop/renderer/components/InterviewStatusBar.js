// InterviewStatusBar - Horizontal status bar with metrics
import { Component } from './Component.js';

export class InterviewStatusBar extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { status: 'idle', metrics: {} };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'interview-status-bar';
    this.el.innerHTML = `
      <div class="isb-left">
        <span class="isb-dot" id="isbDot"></span>
        <span class="isb-status" id="isbStatus">IDLE</span>
      </div>
      <div class="isb-metrics" id="isbMetrics"></div>
    `;
    this._applyStyles();
    return this.el;
  }

  onUpdate(state) {
    if (state.status) {
      const colors = { idle:'#64748b', listening:'#22c55e', speaking:'#3b82f6', processing:'#eab308', error:'#ef4444' };
      this.$('#isbDot').style.background = colors[state.status] || '#64748b';
      this.$('#isbStatus').textContent = state.status.toUpperCase();
      this.el.dataset.status = state.status;
    }
    if (state.metrics) {
      const m = this.$('#isbMetrics');
      m.innerHTML = Object.entries(state.metrics).map(([k, v]) =>
        `<span class="isb-metric"><span class="isb-metric-label">${k}</span><span class="isb-metric-val">${v}</span></span>`
      ).join('');
    }
  }

  _applyStyles() {
    if (document.getElementById('isb-styles')) return;
    const s = document.createElement('style');
    s.id = 'isb-styles';
    s.textContent = `
      .interview-status-bar { display:flex; align-items:center; justify-content:space-between; padding:6px 12px; background:var(--input,#111827); border-radius:8px; font-size:.75em; }
      .isb-left { display:flex; align-items:center; gap:6px; }
      .isb-dot { width:7px; height:7px; border-radius:50%; background:#64748b; }
      .isb-status { font-weight:600; color:var(--text,#e2e8f0); letter-spacing:.5px; }
      .isb-metrics { display:flex; gap:10px; }
      .isb-metric { display:flex; gap:3px; color:var(--text2,#64748b); }
      .isb-metric-label { color:var(--text2); }
      .isb-metric-val { color:var(--accent2,#a78bfa); font-family:'SF Mono',monospace; }
    `;
    document.head.appendChild(s);
  }
}
