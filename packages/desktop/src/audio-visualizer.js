// Real-time Audio Visualizer
// Renders actual microphone volume data - not fake animations
// Supports waveform, frequency bars, and circular modes

export class AudioVisualizer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyser = null;
    this.animationFrame = null;
    this.isActive = false;
    this.mode = options.mode || 'bars'; // 'bars', 'wave', 'circular', 'dots'
    this.colors = options.colors || {
      primary: '#00e5ff',
      secondary: '#7c4dff',
      glow: 'rgba(0, 229, 255, 0.3)',
      background: 'rgba(0, 0, 0, 0)',
    };
    this.smoothing = options.smoothing || 0.8;
    this.scale = options.scale || 1;
    this._lastLevels = null;
    this._onLevel = options.onLevel || null;
  }

  attach(analyserNode) {
    this.analyser = analyserNode;
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = this.smoothing;
  }

  start() {
    if (this.isActive) return;
    this.isActive = true;
    this._resize();
    this._draw();
  }

  stop() {
    this.isActive = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
    this._clear();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = rect.width;
    this.height = rect.height;
    // Pre-allocate frequency data buffer
    if (this.analyser) {
      this._dataBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  _clear() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _draw() {
    if (!this.isActive || !this.analyser || !this.ctx) return;
    this.animationFrame = requestAnimationFrame(() => this._draw());

    const bufferLength = this.analyser.frequencyBinCount;
    if (!this._dataBuffer || this._dataBuffer.length !== bufferLength) {
      this._dataBuffer = new Uint8Array(bufferLength);
    }
    this.analyser.getByteFrequencyData(this._dataBuffer);
    const dataArray = this._dataBuffer;

    // Calculate RMS level for external callbacks
    let sum = 0;
    for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
    const avgLevel = sum / bufferLength / 255;
    if (this._onLevel) this._onLevel(avgLevel);

    this._clear();

    switch (this.mode) {
      case 'bars': this._drawBars(dataArray, bufferLength); break;
      case 'wave': this._drawWave(dataArray, bufferLength); break;
      case 'circular': this._drawCircular(dataArray, bufferLength); break;
      case 'dots': this._drawDots(dataArray, bufferLength); break;
      default: this._drawBars(dataArray, bufferLength);
    }
  }

  _drawBars(dataArray, bufferLength) {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;
    const barCount = Math.min(64, bufferLength);
    const gap = 2;
    const barWidth = (width - (barCount - 1) * gap) / barCount;

    for (let i = 0; i < barCount; i++) {
      const dataIndex = Math.floor(i * bufferLength / barCount);
      const value = dataArray[dataIndex] / 255;
      const barHeight = value * height * 0.9 * this.scale;

      const x = i * (barWidth + gap);
      const y = (height - barHeight) / 2;

      // Gradient color based on intensity
      const hue = 180 + value * 60; // cyan to blue
      const lightness = 50 + value * 20;
      const alpha = 0.6 + value * 0.4;

      ctx.fillStyle = `hsla(${hue}, 100%, ${lightness}%, ${alpha})`;
      ctx.shadowColor = this.colors.primary;
      ctx.shadowBlur = value * 8;

      // Rounded bar
      const radius = Math.min(barWidth / 2, 3);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + barWidth - radius, y);
      ctx.quadraticCurveTo(x + barWidth, y, x + barWidth, y + radius);
      ctx.lineTo(x + barWidth, y + barHeight - radius);
      ctx.quadraticCurveTo(x + barWidth, y + barHeight, x + barWidth - radius, y + barHeight);
      ctx.lineTo(x + radius, y + barHeight);
      ctx.quadraticCurveTo(x, y + barHeight, x, y + barHeight - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
    }

    ctx.shadowBlur = 0;
  }

  _drawWave(dataArray, bufferLength) {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;

    // Draw filled wave
    ctx.beginPath();
    ctx.moveTo(0, height / 2);

    const sliceWidth = width / bufferLength;
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 255;
      const y = (v * height * 0.8 * this.scale) / 2 + height * 0.1;
      ctx.lineTo(i * sliceWidth, y);
    }

    ctx.lineTo(width, height / 2);

    // Mirror
    for (let i = bufferLength - 1; i >= 0; i--) {
      const v = dataArray[i] / 255;
      const y = height - (v * height * 0.8 * this.scale) / 2 - height * 0.1;
      ctx.lineTo(i * sliceWidth, y);
    }

    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, this.colors.secondary + '60');
    gradient.addColorStop(0.5, this.colors.primary + '80');
    gradient.addColorStop(1, this.colors.secondary + '60');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke the top line
    ctx.beginPath();
    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 255;
      const y = (v * height * 0.8 * this.scale) / 2 + height * 0.1;
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * sliceWidth, y);
    }
    ctx.strokeStyle = this.colors.primary;
    ctx.lineWidth = 2;
    ctx.shadowColor = this.colors.primary;
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawCircular(dataArray, bufferLength) {
    const ctx = this.ctx;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const radius = Math.min(cx, cy) * 0.6 * this.scale;
    const barCount = Math.min(64, bufferLength);

    for (let i = 0; i < barCount; i++) {
      const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
      const dataIndex = Math.floor(i * bufferLength / barCount);
      const value = dataArray[dataIndex] / 255;
      const barLength = value * radius * 0.8;

      const x1 = cx + Math.cos(angle) * radius;
      const y1 = cy + Math.sin(angle) * radius;
      const x2 = cx + Math.cos(angle) * (radius + barLength);
      const y2 = cy + Math.sin(angle) * (radius + barLength);

      const hue = 180 + value * 60;
      ctx.strokeStyle = `hsla(${hue}, 100%, 60%, ${0.5 + value * 0.5})`;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // Center circle
    const avgLevel = Array.from(dataArray).reduce((a, b) => a + b, 0) / bufferLength / 255;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (0.2 + avgLevel * 0.15), 0, Math.PI * 2);
    ctx.fillStyle = this.colors.primary + '40';
    ctx.strokeStyle = this.colors.primary;
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }

  _drawDots(dataArray, bufferLength) {
    const ctx = this.ctx;
    const width = this.width;
    const height = this.height;
    const dotCount = Math.min(48, bufferLength);

    for (let i = 0; i < dotCount; i++) {
      const dataIndex = Math.floor(i * bufferLength / dotCount);
      const value = dataArray[dataIndex] / 255;
      const x = (i / (dotCount - 1)) * width;
      const y = height / 2;
      const size = 2 + value * 6 * this.scale;

      const hue = 180 + value * 60;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue}, 100%, 60%, ${0.4 + value * 0.6})`;
      ctx.shadowColor = this.colors.primary;
      ctx.shadowBlur = value * 12;
      ctx.fill();
    }

    ctx.shadowBlur = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  destroy() {
    this.stop();
    this.analyser = null;
    this.ctx = null;
    this.canvas = null;
  }
}
