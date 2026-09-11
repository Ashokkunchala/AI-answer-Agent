// SettingsPanel - Inline sidebar settings panel
import { Component } from './Component.js';

export class SettingsPanel extends Component {
  constructor(container, options = {}) {
    super(container, options);
    this.state = { visible: false, config: {} };
    this._loadConfig();
  }

  async _loadConfig() {
    try {
      this.state.config = await window.electronAPI?.getConfig?.() || {};
    } catch (e) {
      this.state.config = {};
    }
  }

  render() {
    this.el = document.createElement('div');
    this.el.className = 'settings-sidebar';
    this.el.innerHTML = `
      <div class="ss-header">
        <span class="ss-title">Settings</span>
        <button class="ss-close" id="ssClose">&times;</button>
      </div>
      <div class="ss-body" id="ssBody">
        <div class="ss-section">
          <div class="ss-label">AI Model</div>
          <select class="ss-select" id="ssModel">
            <option value="auto">Auto (Worker selects)</option>
            <option value="gpt-4o">GPT-4o</option>
            <option value="gpt-4o-mini">GPT-4o Mini</option>
            <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
            <option value="claude-3-5-haiku">Claude 3.5 Haiku</option>
            <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
            <option value="llama-3.1-70b">Llama 3.1 70B</option>
          </select>
        </div>

        <div class="ss-section">
          <div class="ss-label">Worker URL</div>
          <input class="ss-input" id="ssWorkerUrl" type="text" placeholder="https://your-worker.workers.dev" />
        </div>

        <div class="ss-section">
          <div class="ss-label">API Key</div>
          <input class="ss-input" id="ssApiKey" type="password" placeholder="dvops_..." />
        </div>

        <div class="ss-section">
          <div class="ss-label">Target Person Name</div>
          <input class="ss-input" id="ssTargetName" type="text" placeholder="e.g. John Smith" />
        </div>

        <div class="ss-section">
          <div class="ss-label">Your Role</div>
          <input class="ss-input" id="ssRoleName" type="text" placeholder="e.g. Senior DevOps Engineer" />
        </div>

        <div class="ss-section">
          <div class="ss-label">Resume</div>
          <div class="ss-file-row">
            <label class="ss-file-btn" id="ssResumeLabel">Choose File</label>
            <input class="ss-file-input" id="ssResumeFile" type="file" accept=".txt,.pdf,.doc,.docx" style="display:none" />
            <span class="ss-file-name" id="ssResumeName">No file chosen</span>
          </div>
        </div>

        <div class="ss-section">
          <div class="ss-label">Job Description</div>
          <div class="ss-file-row">
            <label class="ss-file-btn" id="ssJdLabel">Choose File</label>
            <input class="ss-file-input" id="ssJdFile" type="file" accept=".txt,.pdf,.doc,.docx" style="display:none" />
            <span class="ss-file-name" id="ssJdName">No file chosen</span>
          </div>
        </div>

        <div class="ss-divider"></div>

        <div class="ss-section">
          <div class="ss-label">Mic Device</div>
          <select class="ss-select" id="ssMicDevice">
            <option value="default">System Default</option>
          </select>
        </div>

        <div class="ss-section">
          <div class="ss-label">Mic Language</div>
          <select class="ss-select" id="ssMicLang">
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="hi">Hindi</option>
            <option value="ja">Japanese</option>
            <option value="zh">Chinese</option>
          </select>
        </div>

        <div class="ss-section">
          <div class="ss-label">VAD Threshold</div>
          <input class="ss-range" id="ssVadThreshold" type="range" min="1" max="50" value="15" />
          <span class="ss-range-val" id="ssVadVal">15</span>
        </div>

        <div class="ss-section">
          <div class="ss-label">Mic Gain</div>
          <input class="ss-range" id="ssMicGain" type="range" min="1" max="10" value="2" />
          <span class="ss-range-val" id="ssMicGainVal">2</span>
        </div>

        <div class="ss-section">
          <div class="ss-label">Overlay Opacity</div>
          <input class="ss-range" id="ssOpacity" type="range" min="30" max="100" value="95" />
          <span class="ss-range-val" id="ssOpacityVal">95%</span>
        </div>

        <div class="ss-section">
          <div class="ss-label">Font Size</div>
          <input class="ss-range" id="ssFontSize" type="range" min="12" max="36" value="24" />
          <span class="ss-range-val" id="ssFontSizeVal">24px</span>
        </div>

        <div class="ss-divider"></div>

        <div class="ss-section">
          <button class="ss-btn ss-btn-primary" id="ssSave">Save Settings</button>
        </div>
      </div>
    `;
    this._applyStyles();
    this._bindEvents();
    return this.el;
  }

  _bindEvents() {
    this.on(this.$('#ssClose'), 'click', () => this.hide());

    // Range sliders update display values
    this.on(this.$('#ssVadThreshold'), 'input', (e) => {
      this.$('#ssVadVal').textContent = e.target.value;
    });
    this.on(this.$('#ssMicGain'), 'input', (e) => {
      this.$('#ssMicGainVal').textContent = e.target.value;
    });
    this.on(this.$('#ssOpacity'), 'input', (e) => {
      this.$('#ssOpacityVal').textContent = e.target.value + '%';
    });
    this.on(this.$('#ssFontSize'), 'input', (e) => {
      this.$('#ssFontSizeVal').textContent = e.target.value + 'px';
    });

    // File inputs
    this.on(this.$('#ssResumeFile'), 'change', (e) => {
      const file = e.target.files[0];
      if (file) this.$('#ssResumeName').textContent = file.name;
    });
    this.on(this.$('#ssJdFile'), 'change', (e) => {
      const file = e.target.files[0];
      if (file) this.$('#ssJdName').textContent = file.name;
    });

    // Save button
    this.on(this.$('#ssSave'), 'click', () => this._save());
  }

  async _save() {
    const cfg = this.state.config || {};

    // Read file contents if new files selected
    const resumeFile = this.$('#ssResumeFile').files[0];
    const jdFile = this.$('#ssJdFile').files[0];

    if (resumeFile) {
      cfg.resume = await resumeFile.text();
    }
    if (jdFile) {
      cfg.jobDesc = await jdFile.text();
    }

    cfg.model = this.$('#ssModel').value;
    cfg.workerUrl = this.$('#ssWorkerUrl').value;
    cfg.apiKey = this.$('#ssApiKey').value;
    cfg.targetName = this.$('#ssTargetName').value;
    cfg.roleName = this.$('#ssRoleName').value;
    cfg.micDevice = this.$('#ssMicDevice').value;
    cfg.micLanguage = this.$('#ssMicLang').value;
    cfg.micVadThreshold = parseInt(this.$('#ssVadThreshold').value);
    cfg.micGain = parseInt(this.$('#ssMicGain').value);
    cfg.overlayOpacity = parseInt(this.$('#ssOpacity').value) / 100;
    cfg.fontSize = parseInt(this.$('#ssFontSize').value);

    try {
      await window.electronAPI?.saveConfig?.(cfg);
      this.state.config = cfg;
      this._showToast('Settings saved');
      setTimeout(() => this.hide(), 500);
    } catch (e) {
      this._showToast('Failed to save: ' + (e.message || e));
    }
  }

  _showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'ss-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2000);
  }

  async show() {
    await this._loadConfig();
    const c = this.state.config;
    this.$('#ssModel').value = c.model || 'auto';
    this.$('#ssWorkerUrl').value = c.workerUrl || '';
    this.$('#ssApiKey').value = c.apiKey || '';
    this.$('#ssTargetName').value = c.targetName || '';
    this.$('#ssRoleName').value = c.roleName || '';
    this.$('#ssMicDevice').value = c.micDevice || 'default';
    this.$('#ssMicLang').value = c.micLanguage || 'en';
    this.$('#ssVadThreshold').value = c.micVadThreshold || 15;
    this.$('#ssVadVal').textContent = c.micVadThreshold || 15;
    this.$('#ssMicGain').value = c.micGain || 2;
    this.$('#ssMicGainVal').textContent = c.micGain || 2;
    this.$('#ssOpacity').value = Math.round((c.overlayOpacity || 0.95) * 100);
    this.$('#ssOpacityVal').textContent = Math.round((c.overlayOpacity || 0.95) * 100) + '%';
    this.$('#ssFontSize').value = c.fontSize || 24;
    this.$('#ssFontSizeVal').textContent = (c.fontSize || 24) + 'px';
    if (c.resume) this.$('#ssResumeName').textContent = 'Loaded';
    if (c.jobDesc) this.$('#ssJdName').textContent = 'Loaded';

    this.state.visible = true;
    this.el.classList.add('open');
  }

  hide() {
    this.state.visible = false;
    this.el.classList.remove('open');
    this.emit('settings-close');
  }

  toggle() { this.state.visible ? this.hide() : this.show(); }

  _applyStyles() {
    if (document.getElementById('sp-styles')) return;
    const s = document.createElement('style');
    s.id = 'sp-styles';
    s.textContent = `
      .settings-sidebar {
        position:fixed; top:0; right:-320px; width:310px; height:100vh;
        background:#0d1117; border-left:1px solid rgba(255,255,255,0.08);
        z-index:10000; display:flex; flex-direction:column;
        transition:right 0.25s ease; box-shadow:-4px 0 20px rgba(0,0,0,0.4);
        font-size:12px;
      }
      .settings-sidebar.open { right:0; }
      .ss-header {
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 14px; border-bottom:1px solid rgba(255,255,255,0.08);
        background:rgba(15,15,28,0.95); flex-shrink:0;
      }
      .ss-title { font-size:13px; font-weight:600; color:#a78bfa; }
      .ss-close {
        width:26px; height:26px; border:none; border-radius:6px;
        background:transparent; color:#64748b; font-size:18px;
        cursor:pointer; display:flex; align-items:center; justify-content:center;
      }
      .ss-close:hover { background:rgba(255,255,255,0.08); color:#e2e8f0; }
      .ss-body {
        flex:1; overflow-y:auto; padding:8px 14px 14px;
        display:flex; flex-direction:column; gap:10px;
      }
      .ss-body::-webkit-scrollbar { width:4px; }
      .ss-body::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:2px; }
      .ss-section { display:flex; flex-direction:column; gap:4px; }
      .ss-label { font-size:10px; font-weight:600; color:#64748b; text-transform:uppercase; letter-spacing:0.5px; }
      .ss-input, .ss-select {
        padding:6px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:6px;
        background:rgba(255,255,255,0.04); color:#e2e8f0; font-size:12px;
        outline:none; transition:border-color 0.15s;
      }
      .ss-input:focus, .ss-select:focus { border-color:#6C63FF; }
      .ss-select { cursor:pointer; }
      .ss-select option { background:#0d1117; color:#e2e8f0; }
      .ss-range {
        -webkit-appearance:none; width:100%; height:4px;
        background:rgba(255,255,255,0.08); border-radius:2px; outline:none;
      }
      .ss-range::-webkit-slider-thumb {
        -webkit-appearance:none; width:14px; height:14px;
        border-radius:50%; background:#6C63FF; cursor:pointer;
      }
      .ss-range-val { font-size:11px; color:#a78bfa; text-align:right; }
      .ss-divider { height:1px; background:rgba(255,255,255,0.06); margin:4px 0; }
      .ss-file-row { display:flex; align-items:center; gap:8px; }
      .ss-file-btn {
        padding:4px 10px; border:1px solid rgba(255,255,255,0.1); border-radius:6px;
        background:rgba(255,255,255,0.04); color:#a78bfa; font-size:11px;
        cursor:pointer; transition:all 0.15s; white-space:nowrap;
      }
      .ss-file-btn:hover { background:rgba(108,99,255,0.15); }
      .ss-file-name { font-size:11px; color:#64748b; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-btn {
        padding:8px 16px; border:none; border-radius:6px; font-size:12px;
        font-weight:600; cursor:pointer; transition:all 0.15s; width:100%;
      }
      .ss-btn-primary { background:#6C63FF; color:#fff; }
      .ss-btn-primary:hover { background:#7B73FF; }
      .ss-toast {
        position:fixed; bottom:20px; left:50%; transform:translateX(-50%) translateY(20px);
        background:#22c55e; color:#fff; padding:8px 20px; border-radius:8px;
        font-size:12px; font-weight:500; opacity:0; transition:all 0.3s ease;
        z-index:99999; pointer-events:none;
      }
      .ss-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    `;
    document.head.appendChild(s);
  }
}
