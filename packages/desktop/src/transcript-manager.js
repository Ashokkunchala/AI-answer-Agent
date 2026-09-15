// TranscriptManager — accumulates partial transcripts in real-time
// and emits the final turn transcript when Deepgram signals EndOfTurn.
//
// Flow:
//   Deepgram partial → "What is Kubernetes..."
//   Deepgram partial → "What is Kubernetes and how does it work?"
//   Deepgram final   → "What is Kubernetes and how does it work?"  (is_final=true)
//   Deepgram UtteranceEnd → emit 'turn-complete' with accumulated transcript
//
// The manager handles:
// - Partial accumulation (latest partial replaces previous)
// - Final accumulation (finals are appended to the turn buffer)
// - Turn boundaries (UtteranceEnd or speech_final triggers turn-complete)
// - Multi-sentence turns (multiple finals within one turn)

export class TranscriptManager {
  constructor(options = {}) {
    this.onPartial = options.onPartial || (() => {});
    this.onFinal = options.onFinal || (() => {});
    this.onTurnComplete = options.onTurnComplete || (() => {});

    // Current turn state
    this._currentPartial = '';
    this._turnBuffer = [];       // accumulated final transcripts in this turn
    this._turnText = '';         // concatenated finals for this turn
    this._turnCount = 0;
    this._inTurn = false;

    // Metrics
    this._turnStartTime = 0;
    this._firstPartialTime = 0;
    this._firstFinalTime = 0;
  }

  // Called on every Deepgram partial transcript
  handlePartial(transcript, confidence) {
    if (!transcript || !transcript.trim()) return;

    this._currentPartial = transcript.trim();

    if (!this._inTurn) {
      this._inTurn = true;
      this._turnStartTime = Date.now();
      this._turnBuffer = [];
      this._turnText = '';
      this._firstPartialTime = 0;
      this._firstFinalTime = 0;
    }

    if (!this._firstPartialTime) {
      this._firstPartialTime = Date.now();
    }

    // Emit partial with full accumulated text (finals so far + current partial)
    const displayText = this._buildDisplayText();
    this.onPartial({
      transcript: this._currentPartial,
      accumulated: displayText,
      confidence,
      turnIndex: this._turnCount,
    });
  }

  // Called on every Deepgram final transcript (is_final=true or speech_final=true)
  handleFinal(transcript, confidence, words) {
    if (!transcript || !transcript.trim()) return;

    const finalText = transcript.trim();

    if (!this._inTurn) {
      this._inTurn = true;
      this._turnStartTime = Date.now();
      this._turnBuffer = [];
      this._turnText = '';
    }

    if (!this._firstFinalTime) {
      this._firstFinalTime = Date.now();
    }

    // Append to turn buffer
    this._turnBuffer.push(finalText);
    this._turnText = this._turnBuffer.join(' ');
    this._currentPartial = '';

    // Emit individual final
    this.onFinal({
      transcript: finalText,
      accumulated: this._turnText,
      confidence,
      words,
      turnIndex: this._turnCount,
    });
  }

  // Called on Deepgram UtteranceEnd (turn boundary detected by Deepgram)
  handleUtteranceEnd(lastWordEnd) {
    if (!this._inTurn && this._turnBuffer.length === 0) return;

    const turnTranscript = this._turnText.trim();

    if (turnTranscript) {
      const now = Date.now();
      this._turnCount++;

      const metrics = {
        turnIndex: this._turnCount,
        turnDuration: now - this._turnStartTime,
        firstPartialMs: this._firstPartialTime ? this._firstPartialTime - this._turnStartTime : 0,
        firstFinalMs: this._firstFinalTime ? this._firstFinalTime - this._turnStartTime : 0,
        finalCount: this._turnBuffer.length,
      };

      console.log(`[TranscriptManager] Turn #${this._turnCount} complete: "${turnTranscript.substring(0, 80)}" (${metrics.turnDuration}ms, ${metrics.finalCount} finals)`);

      // Emit turn-complete — this is the signal to send to AI
      this.onTurnComplete({
        transcript: turnTranscript,
        turnIndex: this._turnCount,
        metrics,
      });
    }

    // Reset for next turn
    this._resetTurn();
  }

  // Force-flush current turn (e.g., on stop or manual trigger)
  flush() {
    if (!this._inTurn) return null;

    const turnTranscript = this._turnText.trim();
    if (turnTranscript) {
      this._turnCount++;
      this.onTurnComplete({
        transcript: turnTranscript,
        turnIndex: this._turnCount,
        metrics: { finalCount: this._turnBuffer.length, forced: true },
      });
    }

    this._resetTurn();
    return turnTranscript;
  }

  // Get the full display text (finals + current partial)
  _buildDisplayText() {
    const parts = [];
    if (this._turnText) parts.push(this._turnText);
    if (this._currentPartial) parts.push(this._currentPartial);
    return parts.join(' ').trim();
  }

  _resetTurn() {
    this._currentPartial = '';
    this._turnBuffer = [];
    this._turnText = '';
    this._inTurn = false;
    this._turnStartTime = 0;
    this._firstPartialTime = 0;
    this._firstFinalTime = 0;
  }

  reset() {
    this._resetTurn();
    this._turnCount = 0;
  }

  getDisplayText() {
    return this._buildDisplayText();
  }

  getTurnCount() {
    return this._turnCount;
  }
}
