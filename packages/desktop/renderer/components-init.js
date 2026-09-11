import {
  AIHeader, SessionTimer, AudioStatus, TranscriptPanel,
  AIAnswerPanel, ConnectionStatus, ModelInfo, SettingsPanel, ErrorBanner,
  VADIndicator, ContextStatus, UsageStatus, ModeSelector, InterviewInput
} from './components/index.js';

class AIAgentTool {
  constructor() {
    this.components = {};
    this._history = [];
    this._mode = 'interview';
    this._micActive = false;
    this._voiceService = null;
    this._vizCanvas = null;
    this._usage = { requests: 0, tokens: 0 };
  }

  async init() {
    try {
      this.config = await window.electronAPI?.getConfig?.() || {};
    } catch (e) {
      this.config = {};
      console.error('[AI Agent] Error getting config:', e);
    }
    this._mode = this.config.mode || 'interview';
    try {
      console.log('[AI Agent] _buildUI starting');
      this._buildUI();
      console.log('[AI Agent] _buildUI finished');
    } catch (e) {
      console.error('[AI Agent] Error in _buildUI:', e);
    }
    this._wireIPC();
    this._wireKeyboard();
    console.log('[AI Agent] Tool initialized');
  }

  _buildUI() {
    try {
      console.log('[AI Agent] _buildUI entering');
      const app = document.getElementById('app');
      if (!app) { console.error('[AI Agent] #app not found'); return; }
      console.log('[AI Agent] App element found:', app);

      console.log('[AI Agent] Clearing app innerHTML');
      app.innerHTML = '';
      console.log('[AI Agent] Setting app style');
      app.style.cssText = 'display:flex; flex-direction:column; height:100vh; overflow:hidden; background:white;';
      console.log('[AI Agent] App style set:', app.style.cssText);

      // ── HEADER (draggable title bar) ──
      console.log('[AI Agent] Creating header');
      const header = document.createElement('div');
      header.className = 'ai-tool-header';
      app.appendChild(header);
      console.log('[AI Agent] Header element appended');

      const aiHeader = new AIHeader(header, { title: 'AI Answer Agent' });
      console.log('[AI Agent] AIHeader created');
      aiHeader.render();
      console.log('[AI Agent] AIHeader rendered');
      aiHeader.mount();
      console.log('[AI Agent] AIHeader mounted');
      this.components.header = aiHeader;
      aiHeader.el.addEventListener('header-action', (e) => this._onHeaderAction(e.detail));
      console.log('[AI Agent] Header event listener added');

      // ── MODE BAR ──
      console.log('[AI Agent] Creating mode bar');
      const modeBar = document.createElement('div');
      modeBar.className = 'ai-tool-mode-bar';
      app.appendChild(modeBar);
      console.log('[AI Agent] Mode bar appended');

      const modeSelector = new ModeSelector(modeBar, { active: this._mode });
      console.log('[AI Agent] ModeSelector created');
      modeSelector.render();
      console.log('[AI Agent] ModeSelector rendered');
      modeSelector.mount();
      console.log('[AI Agent] ModeSelector mounted');
      this.components.modeSelector = modeSelector;
      modeSelector.el.addEventListener('mode-change', (e) => this._onModeChange(e.detail));
      console.log('[AI Agent] Mode change event listener added');

      // ── STATUS BAR (mic + VAD + timer + connection) ──
      console.log('[AI Agent] Creating status bar');
      const statusBar = document.createElement('div');
      statusBar.className = 'ai-tool-status-bar';
      app.appendChild(statusBar);
      console.log('[AI Agent] Status bar appended');

      const audioStatus = new AudioStatus(statusBar);
      console.log('[AI Agent] AudioStatus created');
      audioStatus.render();
      console.log('[AI Agent] AudioStatus rendered');
      audioStatus.mount();
      console.log('[AI Agent] AudioStatus mounted');
      this.components.audioStatus = audioStatus;

      const vad = new VADIndicator(statusBar);
      console.log('[AI Agent] VADIndicator created');
      vad.render();
      console.log('[AI Agent] VADIndicator rendered');
      vad.mount();
      console.log('[AI Agent] VADIndicator mounted');
      this.components.vad = vad;

      const timer = new SessionTimer(statusBar);
      console.log('[AI Agent] SessionTimer created');
      timer.render();
      console.log('[AI Agent] SessionTimer rendered');
      timer.mount();
      console.log('[AI Agent] SessionTimer mounted');
      this.components.timer = timer;

      const connStatus = new ConnectionStatus(statusBar);
      console.log('[AI Agent] ConnectionStatus created');
      connStatus.render();
      console.log('[AI Agent] ConnectionStatus rendered');
      connStatus.mount();
      console.log('[AI Agent] ConnectionStatus mounted');
      this.components.connStatus = connStatus;

      // ── CONTEXT BAR (resume/JD status) ──
      console.log('[AI Agent] Creating context bar');
      const contextBar = document.createElement('div');
      contextBar.className = 'ai-tool-context-bar';
      app.appendChild(contextBar);
      console.log('[AI Agent] Context bar appended');

      const ctx = new ContextStatus(contextBar);
      console.log('[AI Agent] ContextStatus created');
      ctx.render();
      console.log('[AI Agent] ContextStatus rendered');
      ctx.mount();
      console.log('[AI Agent] ContextStatus mounted');
      this.components.context = ctx;

      const usage = new UsageStatus(contextBar);
      console.log('[AI Agent] UsageStatus created');
      usage.render();
      console.log('[AI Agent] UsageStatus rendered');
      usage.mount();
      console.log('[AI Agent] UsageStatus mounted');
      this.components.usage = usage;

      // ── AUDIO VISUALIZER ──
      console.log('[AI Agent] Creating audio visualizer section');
      const vizSection = document.createElement('div');
      vizSection.className = 'ai-tool-viz';
      app.appendChild(vizSection);
      console.log('[AI Agent] Audio viz section appended');

      const vizLabel = document.createElement('div');
      vizLabel.className = 'ai-tool-section-label';
      vizLabel.textContent = 'AUDIO INPUT';
      vizSection.appendChild(vizLabel);
      console.log('[AI Agent] Audio viz label appended');

      this._vizCanvas = document.createElement('canvas');
      this._vizCanvas.width = 400;
      this._vizCanvas.height = 50;
      this._vizCanvas.style.cssText = 'width:100%; height:50px; border-radius:8px; background:rgba(255,255,255,0.03);';
      vizSection.appendChild(this._vizCanvas);
      console.log('[AI Agent] Audio viz canvas appended');

      // ── LIVE TRANSCRIPT ──
      console.log('[AI Agent] Creating transcript section');
      const transcriptSection = document.createElement('div');
      transcriptSection.className = 'ai-tool-transcript';
      app.appendChild(transcriptSection);
      console.log('[AI Agent] Transcript section appended');

      const transcript = new TranscriptPanel(transcriptSection);
      console.log('[AI Agent] TranscriptPanel created');
      transcript.render();
      console.log('[AI Agent] TranscriptPanel rendered');
      transcript.mount();
      console.log('[AI Agent] TranscriptPanel mounted');
      this.components.transcript = transcript;

      // ── AI ANSWER ──
      console.log('[AI Agent] Creating answer section');
      const answerSection = document.createElement('div');
      answerSection.className = 'ai-tool-answer';
      app.appendChild(answerSection);
      console.log('[AI Agent] Answer section appended');

      const answerPanel = new AIAnswerPanel(answerSection);
      console.log('[AI Agent] AIAnswerPanel created');
      answerPanel.render();
      console.log('[AI Agent] AIAnswerPanel rendered');
      answerPanel.mount();
      console.log('[AI Agent] AIAnswerPanel mounted');
      this.components.answerPanel = answerPanel;

      // ── INPUT ──
      console.log('[AI Agent] Creating input section');
      const inputSection = document.createElement('div');
      inputSection.className = 'ai-tool-input';
      app.appendChild(inputSection);
      console.log('[AI Agent] Input section appended');

      const input = new InterviewInput(inputSection, { placeholder: 'Ask the AI anything...' });
      console.log('[AI Agent] InterviewInput created');
      input.render();
      console.log('[AI Agent] InterviewInput rendered');
      input.mount();
      console.log('[AI Agent] InterviewInput mounted');
      this.components.input = input;
      input.el.addEventListener('input-send', (e) => this._onInputSend(e.detail));
      console.log('[AI Agent] Input event listener added');

      // ── BOTTOM BAR ──
      console.log('[AI Agent] Creating bottom bar');
      const bottomBar = document.createElement('div');
      bottomBar.className = 'ai-tool-bottom';
      app.appendChild(bottomBar);
      console.log('[AI Agent] Bottom bar appended');

      const modelInfo = new ModelInfo(bottomBar);
      console.log('[AI Agent] ModelInfo created');
      modelInfo.render();
      console.log('[AI Agent] ModelInfo rendered');
      modelInfo.mount();
      console.log('[AI Agent] ModelInfo mounted');
      this.components.modelInfo = modelInfo;

      // ── ERROR BANNER ──
      console.log('[AI Agent] Creating error banner');
      const errorBanner = new ErrorBanner(document.body);
      console.log('[AI Agent] ErrorBanner created');
      errorBanner.render();
      console.log('[AI Agent] ErrorBanner rendered');
      errorBanner.mount();
      console.log('[AI Agent] ErrorBanner mounted');
      this.components.errorBanner = errorBanner;

      // ── SETTINGS SIDEBAR ──
      console.log('[AI Agent] Creating settings panel');
      const settings = new SettingsPanel(document.body);
      console.log('[AI Agent] SettingsPanel created');
      settings.render();
      console.log('[AI Agent] SettingsPanel rendered');
      settings.mount();
      console.log('[AI Agent] SettingsPanel mounted');
      this.components.settings = settings;

      console.log('[AI Agent] Injecting styles');
      this._injectStyles();
      console.log('[AI Agent] Styles injected');

      console.log('[AI Agent] Updating context');
      this._updateContext();
      console.log('[AI Agent] Context updated');

      console.log('[AI Agent] Checking worker connection');
      this._checkConnection();
      console.log('[AI Agent] Connection check initiated');

      console.log('[AI Agent] _buildUI leaving');
    } catch (e) {
      console.error('[AI Agent] Error in _buildUI:', e);
      console.error('[AI Agent] Error stack:', e.stack);
    }
  }

  _updateContext() {
    const ctx = this.components.context;
    if (!ctx) return;
    ctx.update({
      hasResume: !!this.config.resume,
      hasJobDesc: !!this.config.jobDesc,
      targetName: this.config.targetName || '',
      participants: this.config.participants || []
    });
  }

  async _checkConnection() {
    try {
      const base = (this.config.workerUrl || '').replace(/\/+$/, '');
      if (!base) {
        this.components.connStatus?.update({ connected: false, latency: null });
        return;
      }
      const start = Date.now();
      const r = await fetch(base + '/health', { method: 'GET' });
      const latency = Date.now() - start;
      this.components.connStatus?.update({ connected: r.ok, latency: r.ok ? latency : null });
    } catch (e) {
      this.components.connStatus?.update({ connected: false, latency: null });
    }
  }

  _onHeaderAction(action) {
    switch (action) {
      case 'settings':
        this.components.settings?.show();
        break;
      case 'minimize':
        window.electronAPI?.minimizeToTray?.();
        break;
      case 'close':
        window.electronAPI?.toggleOverlay?.();
        break;
    }
  }

  _onModeChange(mode) {
    this._mode = mode;
    const titles = {
      interview: 'AI Interview', quick_qa: 'Quick Q&A',
      code_gen: 'Code Gen', debug: 'Debug', review: 'Review', explain: 'Explain'
    };
    this.components.header?.update({ title: titles[mode] || 'AI Agent' });
  }

  async _onInputSend({ text }) {
    if (!text?.trim()) return;
    const input = this.components.input;
    const panel = this.components.answerPanel;
    const header = this.components.header;

    input?.setSending(true);
    panel?.setLoading(true);
    header?.update({ status: 'Thinking...', statusColor: '#eab308' });
    this.components.timer?.start();
    this.components.errorBanner?.hide();

    // Create answer card first so streaming can update it
    panel?.addAnswer({
      question: text,
      answer: '',
      model: '',
      latency: null
    });

    try {
      const result = await window.electronAPI?.queryAI({
        prompt: text,
        history: this._history.slice(-12),
        taskType: this._mode
      });

      const answer = (result && typeof result === 'object' && 'answer' in result)
        ? result.answer : result;

      // Update the existing card with final answer (streaming already updated it)
      panel?.updateLastAnswer(answer || 'No response');
      panel?.updateCardMeta({ model: result?.model || '', latency: result?.latency_ms || null });

      // Track usage
      this._usage.requests++;
      if (result?.usage?.total_tokens) {
        this._usage.tokens += result.usage.total_tokens;
      }
      this.components.usage?.update(this._usage);

      this._history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: answer || '' }
      );
      if (this._history.length > 24) this._history = this._history.slice(-24);

      header?.update({ status: 'Ready', statusColor: '#22c55e' });
      this.components.timer?.stop();
    } catch (err) {
      this.components.errorBanner?.show(err?.message || 'AI request failed');
      header?.update({ status: 'Error', statusColor: '#ef4444' });
      this.components.timer?.stop();
    } finally {
      input?.setSending(false);
      panel?.setLoading(false);
    }
  }

  async _toggleMic() {
    console.log('[AI Agent] _toggleMic called, _micActive=' + this._micActive);
    if (this._micActive) {
      await this._stopMic();
    } else {
      await this._startMic();
    }
  }

  async _startMic() {
    try {
      console.log('[AI Agent] _startMic: importing VoiceService...');
      const { VoiceService } = await import('../src/voice-service.js');
      console.log('[AI Agent] _startMic: creating VoiceService instance');
      const vs = new VoiceService({
        audioSource: this.config.audioSource || 'mic',
        micDevice: this.config.micDevice,
        vadThreshold: this.config.vadThreshold || 0.015,
        vadSilenceMs: this.config.vadSilenceMs || 1200,
        autoSendDelay: this.config.autoSendDelay || 2000,
        sttType: this.config.sttType || 'auto',
        deepgramApiKey: this.config.deepgramApiKey || '',
        workerUrl: this.config.workerUrl || '',
        debug: false
      });

      vs.on('state', (data) => {
        this.components.audioStatus?.update({ micActive: data.state !== 'IDLE' });
        this.components.header?.update({
          status: data.state,
          statusColor: data.state === 'SPEAKING' ? '#22c55e' : data.state === 'PROCESSING' ? '#eab308' : '#64748b'
        });
      });

      vs.on('mic-started', (data) => {
        this.components.audioStatus?.update({ deviceName: data.deviceName, micActive: true });
      });

      vs.on('mic-stopped', () => {
        this.components.audioStatus?.update({ micActive: false, deviceName: 'Disconnected' });
      });

      vs.on('partial-transcript', (data) => {
        this.components.transcript?.setInterim(data.transcript);
      });

      vs.on('final-transcript', (data) => {
        this.components.transcript?.setInterim('');
        if (data.transcript?.trim()) {
          this.components.transcript?.addMessage(data.transcript, 'final');
          if (this._mode === 'interview' && data.accumulated) {
            this._handleAutoQuery(data.accumulated);
          }
        }
      });

      vs.on('speech-start', () => {
        this.components.vad?.update({ speaking: true });
      });

      vs.on('speech-end', () => {
        this.components.vad?.update({ speaking: false });
      });

      vs.on('error', (data) => {
        this.components.errorBanner?.show(data.message || 'Voice error');
      });

      vs.on('latency', (data) => {
        this.components.modelInfo?.update({ latency: data.stt });
      });

      await vs.start();

      // Attach visualizer canvas to VoiceService's built-in analyser
      if (this._vizCanvas) {
        vs.attachVisualizer(this._vizCanvas);
      }

      this._voiceService = vs;
      this._micActive = true;
      this.components.timer?.start();
    } catch (err) {
      this.components.errorBanner?.show('Mic error: ' + (err?.message || err));
    }
  }

  async _stopMic() {
    if (this._voiceService) {
      this._voiceService.detachVisualizer();
      this._voiceService.stop();
      this._voiceService = null;
    }
    this._micActive = false;
    this.components.vad?.update({ speaking: false });
    this.components.audioStatus?.update({ micActive: false });
    this.components.timer?.stop();
  }

  async _handleAutoQuery(transcript) {
    if (!transcript?.trim()) return;
    this._onInputSend({ text: transcript });
  }

  _wireKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        window.electronAPI?.toggleOverlay?.();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        this._toggleMic();
      }
    });
  }

  _wireIPC() {
    if (!window.electronAPI) return;

    window.electronAPI.onAnswerStream?.((data) => {
      this.components.answerPanel?.updateLastAnswer(data.answer || '');
    });

    window.electronAPI.onAnswerReady?.((data) => {
      // Handle OCR-type answer-ready events
      if (data && data.type === 'ocr') {
        // OCR detected a question - add it to transcript
        if (data.text) {
          this.components.transcript?.addMessage(data.text, 'final');
        }
        return;
      }
      // Handle regular answer-ready events
      this.components.answerPanel?.addAnswer(data);
      this.components.timer?.stop();
      this.components.header?.update({ status: 'Ready', statusColor: '#22c55e' });
      // Update connection status on successful query
      this.components.connStatus?.update({ connected: true, latency: data.latency_ms || null });
    });

    window.electronAPI.onToggleMic?.(() => {
      this._toggleMic();
    });

    window.electronAPI.onResumeUpdated?.(async () => {
      this.config = await window.electronAPI.getConfig();
      this._updateContext();
    });

    window.electronAPI.onJobDescUpdated?.(async () => {
      this.config = await window.electronAPI.getConfig();
      this._updateContext();
    });

    // Wire answer-copy and answer-save events
    this.components.answerPanel?.el?.addEventListener('answer-copy', async (e) => {
      const data = e.detail;
      if (data?.question && data?.answer) {
        await window.electronAPI?.saveHistory?.({
          question: data.question,
          answer: data.answer,
          type: this._mode || 'general',
          metadata: { model: data.model, latency: data.latency }
        });
      }
    });

    this.components.answerPanel?.el?.addEventListener('answer-save', async (e) => {
      const data = e.detail;
      if (data?.question && data?.answer) {
        await window.electronAPI?.saveHistory?.({
          question: data.question,
          answer: data.answer,
          type: this._mode || 'general',
          metadata: { model: data.model, latency: data.latency }
        });
      }
    });
  }

  _injectStyles() {
    if (document.getElementById('ai-tool-styles')) return;
    const s = document.createElement('style');
    s.id = 'ai-tool-styles';
    s.textContent = `
      html, body { background: #0a0a14 !important; margin: 0; padding: 0; }
      .app { background: #0a0a14 !important; }
      .ai-tool-header { flex-shrink: 0; }
      .ai-tool-mode-bar { padding: 6px 12px; border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0; display: flex; gap: 4px; flex-wrap: wrap; }
      .ai-tool-status-bar { display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(15,15,28,0.95); flex-shrink:0; }
      .ai-tool-context-bar { display:flex; align-items:center; gap:8px; padding:4px 12px; border-bottom:1px solid rgba(255,255,255,0.06); flex-shrink:0; }
      .ai-tool-viz { padding:6px 12px; border-bottom:1px solid rgba(255,255,255,0.06); flex-shrink:0; }
      .ai-tool-section-label { font-size:10px; font-weight:600; color:#64748b; letter-spacing:1px; margin-bottom:4px; }
      .ai-tool-transcript { flex:0 0 auto; max-height:180px; overflow:hidden; display:flex; flex-direction:column; border-bottom:1px solid rgba(255,255,255,0.06); }
      .ai-tool-answer { flex:1; min-height:120px; overflow:hidden; display:flex; flex-direction:column; }
      .ai-tool-input { flex-shrink:0; border-top:1px solid rgba(255,255,255,0.06); }
      .ai-tool-bottom { display:flex; align-items:center; gap:8px; padding:4px 12px; border-top:1px solid rgba(255,255,255,0.06); background:rgba(15,15,28,0.95); font-size:0.75em; flex-shrink:0; }
    `;
    document.head.appendChild(s);
  }

  get(name) { return this.components[name]; }
}

const tool = new AIAgentTool();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => tool.init());
} else {
  tool.init();
}
window._aiTool = tool;
