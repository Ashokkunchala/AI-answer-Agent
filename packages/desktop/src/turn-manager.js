// TurnManager — manages conversation turns and triggers AI responses.
//
// Responsibilities:
// - Receives turn-complete events from TranscriptManager
// - Debounces rapid turns (e.g., interviewer rephrases quickly)
// - Decides when to send to AI
// - Tracks turn history for context
// - Emits 'turn-ready' with the complete question for AI
//
// The TurnManager sits between TranscriptManager and the AI query system.

export class TurnManager {
  constructor(options = {}) {
    this.onTurnReady = options.onTurnReady || (() => {});
    this.onError = options.onError || (() => {});

    // Configuration
    this._debounceMs = options.debounceMs ?? 800;   // wait this long after last final before sending
    this._minTranscriptLength = options.minTranscriptLength ?? 3;
    this._maxTurnAge = options.maxTurnAge ?? 10000;  // discard turns older than this

    // State
    this._pendingTurn = null;
    this._debounceTimer = null;
    this._turnHistory = [];
    this._isProcessing = false;
    this._enabled = true;

    // Metrics
    this._totalTurns = 0;
    this._totalDebounced = 0;
  }

  // Called when TranscriptManager emits turn-complete
  handleTurnComplete(turnData) {
    if (!this._enabled) return;

    const { transcript, turnIndex, metrics } = turnData;

    if (!transcript || transcript.trim().length < this._minTranscriptLength) {
      console.log(`[TurnManager] Turn #${turnIndex} too short, skipping: "${transcript}"`);
      return;
    }

    // If we're already processing an AI request, queue this turn
    if (this._isProcessing) {
      console.log(`[TurnManager] Turn #${turnIndex} queued (AI processing in progress)`);
      this._pendingTurn = { transcript, turnIndex, metrics, timestamp: Date.now() };
      return;
    }

    // Debounce: wait for potential follow-up speech
    this._debounceTurn(transcript, turnIndex, metrics);
  }

  _debounceTurn(transcript, turnIndex, metrics) {
    // Cancel previous debounce if a new turn arrives
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._totalDebounced++;
    }

    this._pendingTurn = { transcript, turnIndex, metrics, timestamp: Date.now() };

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._sendToAI(this._pendingTurn);
      this._pendingTurn = null;
    }, this._debounceMs);
  }

  _sendToAI(turn) {
    if (!turn || !turn.transcript) return;

    this._totalTurns++;
    this._isProcessing = true;

    // Add to history
    this._turnHistory.push({
      transcript: turn.transcript,
      turnIndex: turn.turnIndex,
      timestamp: turn.timestamp || Date.now(),
      metrics: turn.metrics,
    });

    // Keep history bounded
    if (this._turnHistory.length > 50) {
      this._turnHistory = this._turnHistory.slice(-50);
    }

    console.log(`[TurnManager] Turn #${turn.turnIndex} ready for AI: "${turn.transcript.substring(0, 80)}"`);

    // Emit turn-ready — VoiceService will send this to AI
    this.onTurnReady({
      transcript: turn.transcript,
      turnIndex: turn.turnIndex,
      history: this._turnHistory.slice(-10),  // last 10 turns for context
      metrics: turn.metrics,
    });
  }

  // Called by VoiceService when AI response completes
  onAIComplete() {
    this._isProcessing = false;

    // If a turn was queued while processing, send it now
    if (this._pendingTurn) {
      const queued = this._pendingTurn;
      this._pendingTurn = null;

      // Only send if turn is still fresh
      const age = Date.now() - (queued.timestamp || 0);
      if (age < this._maxTurnAge) {
        console.log(`[TurnManager] Sending queued turn #${queued.turnIndex} (was waiting ${age}ms)`);
        this._sendToAI(queued);
      } else {
        console.log(`[TurnManager] Discarding stale queued turn #${queued.turnIndex} (age: ${age}ms)`);
      }
    }
  }

  // Force-flush (e.g., on stop)
  forceFlush() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingTurn) {
      this._sendToAI(this._pendingTurn);
      this._pendingTurn = null;
    }
  }

  enable() { this._enabled = true; }
  disable() { this._enabled = false; }

  isProcessing() { return this._isProcessing; }

  getHistory() { return [...this._turnHistory]; }

  getMetrics() {
    return {
      totalTurns: this._totalTurns,
      totalDebounced: this._totalDebounced,
      isProcessing: this._isProcessing,
      hasPending: !!this._pendingTurn,
    };
  }

  reset() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingTurn = null;
    this._turnHistory = [];
    this._isProcessing = false;
    this._totalTurns = 0;
    this._totalDebounced = 0;
  }
}
