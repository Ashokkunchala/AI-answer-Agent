// ErrorBanner - Dismissible error notification banner
import { Component } from './Component.js';

export class ErrorBanner extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { message: '', visible: false, autoHide: options.autoHide || 5000 };
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'error-banner';
    this.el.innerHTML = `
      <span class="eb-icon">&#9888;</span>
      <span class="eb-message" id="ebMessage"></span>
      <button class="eb-close" id="ebClose">&times;</button>
    `;
    this._applyStyles();
    this.on(this.$('#ebClose'), 'click', () => this.hide());
    return this.el;
  }

  show(message) {
    this.state.message = message;
    this.state.visible = true;
    this.$('#ebMessage').textContent = message;
    this.el.style.display = 'flex';
    this.el.classList.add('eb-enter');
    if (this.state.autoHide > 0) {
      this.setTimeout(() => this.hide(), this.state.autoHide);
    }
  }

  hide() {
    this.state.visible = false;
    this.el.style.display = 'none';
    this.el.classList.remove('eb-enter');
  }

  _applyStyles() {
    if (document.getElementById('eb-styles')) return;
    const s = document.createElement('style');
    s.id = 'eb-styles';
    s.textContent = `
      .error-banner { display:none; align-items:center; gap:8px; padding:8px 12px; background:#ef444422; border:1px solid #ef444444; border-radius:8px; margin:8px 12px; font-size:.82em; color:#fca5a5; }
      .error-banner.eb-enter { animation:fadeIn .2s; }
      .eb-icon { font-size:1.1em; flex-shrink:0; }
      .eb-message { flex:1; }
      .eb-close { background:none; border:none; color:#fca5a5; cursor:pointer; font-size:1.1em; padding:0 4px; }
      .eb-close:hover { color:#fff; }
    `;
    document.head.appendChild(s);
  }
}
