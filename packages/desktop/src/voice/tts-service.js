const { spawn } = require('child_process');

/**
 * Cross-platform TTS adapter.
 * Uses the host's native speech engine when available and stays replaceable
 * by a cloud TTS provider later. No provider credentials are stored here.
 */
class TTSService {
  constructor({ voice = null, rate = 180 } = {}) {
    this.voice = voice;
    this.rate = rate;
    this.process = null;
  }

  speak(text) {
    const value = String(text || '').trim();
    if (!value) return Promise.resolve();

    this.stop();

    if (process.platform === 'win32') {
      const escaped = value.replace(/'/g, "''");
      const voice = this.voice ? `$speak.SelectVoice('${String(this.voice).replace(/'/g, "''")}');` : '';
      const script = `$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice}$speak.Rate = ${Math.max(-10, Math.min(10, Math.round((this.rate - 180) / 20)))}; $speak.Speak('${escaped}'); $speak.Dispose()`;
      return new Promise((resolve, reject) => {
        this.process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        this.process.once('error', reject);
        this.process.once('close', () => { this.process = null; resolve(); });
      });
    }

    // macOS fallback. Linux can be wired to an installed `espeak`/`spd-say`
    // adapter without changing the public TTS interface.
    if (process.platform === 'darwin') {
      return new Promise((resolve, reject) => {
        this.process = spawn('say', [value]);
        this.process.once('error', reject);
        this.process.once('close', () => { this.process = null; resolve(); });
      });
    }

    return Promise.resolve();
  }

  stop() {
    if (this.process && !this.process.killed) {
      this.process.kill();
      this.process = null;
    }
  }
}

module.exports = { TTSService };
