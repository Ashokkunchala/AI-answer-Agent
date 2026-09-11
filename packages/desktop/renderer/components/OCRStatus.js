// OCRStatus - OCR engine status indicator
import { Component } from './Component.js';

export class OCRStatus extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { loaded: false, language: 'eng', confidence: null };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'ocr-status';
    this._applyStyles();
    this._updateContent();
    return this.el;
  }

  onUpdate(state) {
    this._updateContent();
  }

  _updateContent() {
    const { loaded, language, confidence } = this.state;
    const conf = confidence !== null ? `${Math.round(confidence * 100)}%` : '--';
    this.el.innerHTML = `
      <span class="ocrs-dot" style="background:${loaded ? '#22c55e' : '#64748b'}"></span>
      <span class="ocrs-text">OCR: ${loaded ? language.toUpperCase() : 'Loading...'}</span>
      ${loaded ? `<span class="ocrs-conf">${conf}</span>` : ''}
    `;
  }

  _applyStyles() {
    if (document.getElementById('ocrs-styles')) return;
    const s = document.createElement('style');
    s.id = 'ocrs-styles';
    s.textContent = `
      .ocr-status { display:inline-flex; align-items:center; gap:5px; font-size:.75em; padding:2px 8px; border-radius:6px; background:var(--input,#111827); color:var(--text2,#64748b); }
      .ocrs-dot { width:6px; height:6px; border-radius:50%; }
      .ocrs-conf { font-family:'SF Mono',monospace; font-size:.85em; }
    `;
    document.head.appendChild(s);
  }
}
