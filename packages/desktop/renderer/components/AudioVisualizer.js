// AudioVisualizer - Canvas-based audio visualization (bars/wave/circular)
import { Component } from './Component.js';

export class AudioVisualizer extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { mode: options.mode || 'bars', color: options.color || '#8B5CF6', active: false };
    this._canvas = null;
    this._ctx = null;
    this._analyser = null;
    this._animFrame = null;
    this._dataArray = null;
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'audio-visualizer';
    this._canvas = document.createElement('canvas');
    this._canvas.width = this.options.width || 300;
    this._canvas.height = this.options.height || 60;
    this._ctx = this._canvas.getContext('2d');
    this.el.appendChild(this._canvas);
    this._applyStyles();
    return this.el;
  }

  attach(analyserNode) {
    this._analyser = analyserNode;
    this._dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  }

  start() {
    this.state.active = true;
    this._draw();
  }

  stop() {
    this.state.active = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
  }

  setMode(mode) { this.state.mode = mode; }

  _draw() {
    if (!this.state.active) return;
    this._animFrame = requestAnimationFrame(() => this._draw());
    if (!this._analyser || !this._ctx) return;

    this._analyser.getByteFrequencyData(this._dataArray);
    const w = this._canvas.width;
    const h = this._canvas.height;
    this._ctx.clearRect(0, 0, w, h);

    switch (this.state.mode) {
      case 'bars': this._drawBars(w, h); break;
      case 'wave': this._drawWave(w, h); break;
      case 'circular': this._drawCircular(w, h); break;
      default: this._drawBars(w, h);
    }
  }

  _drawBars(w, h) {
    const bars = 32;
    const gap = 2;
    const barW = (w - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(i * this._dataArray.length / bars);
      const val = this._dataArray[idx] / 255;
      const barH = val * h;
      this._ctx.fillStyle = this.state.color;
      this._ctx.globalAlpha = 0.4 + val * 0.6;
      this._ctx.fillRect(i * (barW + gap), h - barH, barW, barH);
    }
    this._ctx.globalAlpha = 1;
  }

  _drawWave(w, h) {
    this._analyser.getByteTimeDomainData(this._dataArray);
    this._ctx.beginPath();
    this._ctx.strokeStyle = this.state.color;
    this._ctx.lineWidth = 2;
    const sliceW = w / this._dataArray.length;
    for (let i = 0; i < this._dataArray.length; i++) {
      const v = this._dataArray[i] / 128.0;
      const y = v * h / 2;
      i === 0 ? this._ctx.moveTo(0, y) : this._ctx.lineTo(i * sliceW, y);
    }
    this._ctx.stroke();
  }

  _drawCircular(w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(cx, cy) - 4;
    const bars = 48;
    for (let i = 0; i < bars; i++) {
      const angle = (i / bars) * Math.PI * 2 - Math.PI / 2;
      const idx = Math.floor(i * this._dataArray.length / bars);
      const val = this._dataArray[idx] / 255;
      const len = 4 + val * radius;
      this._ctx.beginPath();
      this._ctx.moveTo(cx + Math.cos(angle) * 4, cy + Math.sin(angle) * 4);
      this._ctx.lineTo(cx + Math.cos(angle) * len, cy + Math.sin(angle) * len);
      this._ctx.strokeStyle = this.state.color;
      this._ctx.globalAlpha = 0.4 + val * 0.6;
      this._ctx.lineWidth = 2;
      this._ctx.stroke();
    }
    this._ctx.globalAlpha = 1;
  }

  _applyStyles() {
    if (document.getElementById('audio-visualizer-styles')) return;
    const s = document.createElement('style');
    s.id = 'audio-visualizer-styles';
    s.textContent = `.audio-visualizer { display:flex; justify-content:center; } .audio-visualizer canvas { border-radius:8px; }`;
    document.head.appendChild(s);
  }
}
