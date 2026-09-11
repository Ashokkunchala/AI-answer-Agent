// AIOverlay - Main overlay container with show/hide/opacity controls
import { Component } from './Component.js';

export class AIOverlay extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { visible: true, opacity: 0.95, mode: 'full' };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ai-overlay';
    this.el.innerHTML = `
      <div class="ai-overlay-backdrop"></div>
      <div class="ai-overlay-content">
        <div class="ai-overlay-slot header-slot"></div>
        <div class="ai-overlay-slot body-slot"></div>
        <div class="ai-overlay-slot footer-slot"></div>
      </div>
    `;
    this._applyStyles();
    return this.el;
  }

  onUpdate(state) {
    if (state.visible !== undefined) {
      this.el.style.display = state.visible ? '' : 'none';
    }
    if (state.opacity !== undefined) {
      this.el.querySelector('.ai-overlay-content').style.opacity = state.opacity;
    }
    if (state.mode) {
      this.el.dataset.mode = state.mode;
    }
  }

  show() { this.update({ visible: true }); }
  hide() { this.update({ visible: false }); }
  toggle() { this.update({ visible: !this.state.visible }); }

  getSlot(name) {
    return this.el.querySelector(`.${name}-slot`);
  }

  _applyStyles() {
    if (document.getElementById('ai-overlay-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-overlay-styles';
    style.textContent = `
      .ai-overlay { position:fixed; top:0; right:0; bottom:0; width:var(--overlay-width,420px); z-index:9999; display:flex; flex-direction:column; font-family:inherit; }
      .ai-overlay[data-mode="compact"] { width:var(--overlay-compact-width,320px); }
      .ai-overlay[data-mode="collapsed"] { width:48px; }
      .ai-overlay[data-mode="collapsed"] .ai-overlay-content { opacity:0; pointer-events:none; }
      .ai-overlay-backdrop { position:absolute; inset:0; background:var(--overlay-bg,rgba(10,10,20,0.92)); border-left:1px solid var(--border,#1e2a3a); }
      .ai-overlay-content { position:relative; z-index:1; display:flex; flex-direction:column; height:100%; overflow:hidden; }
      .ai-overlay-slot { flex-shrink:0; }
      .ai-overlay-slot.body-slot { flex:1; overflow-y:auto; }
    `;
    document.head.appendChild(style);
  }
}
