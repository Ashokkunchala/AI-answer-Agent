// StealthStatus - Current stealth mode display
import { Component } from './Component.js';

export class StealthStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { active: false, opacity: 0.95, clickThrough: false, titleRotation: true };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'stealth-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const { active, opacity, clickThrough, titleRotation } = this.state;
    const features = [];
    features.push(`<span class="ss-feature ${active ? 'ss-on' : ''}">Stealth: ${active ? 'ON' : 'OFF'}</span>`);
    if (active) {
      features.push(`<span class="ss-feature">Opacity: ${Math.round(opacity * 100)}%</span>`);
      if (clickThrough) features.push('<span class="ss-feature ss-on">Click-through</span>');
      if (titleRotation) features.push('<span class="ss-feature ss-on">Title rotation</span>');
    }
    this.el.innerHTML = features.join('');
  }

  _applyStyles() {
    if (document.getElementById('ss-styles')) return;
    const s = document.createElement('style');
    s.id = 'ss-styles';
    s.textContent = `
      .stealth-status { display:flex; gap:6px; flex-wrap:wrap; }
      .ss-feature { font-size:.72em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); color:var(--text2,#64748b); }
      .ss-feature.ss-on { color:var(--green,#22c55e); }
    `;
    document.head.appendChild(s);
  }
}
