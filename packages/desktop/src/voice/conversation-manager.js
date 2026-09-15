// conversation-manager.js — bounded conversational context for the session.
//
// Keeps the most recent N Q&A turns verbatim plus a compact summary of older
// turns, so long interviews stay in context without unbounded memory or prompt
// growth. Feeds both the chat-completions path (as a system message) and the
// worker /api/answer path (as { conversationContext }).
'use strict';

class ConversationManager {
  constructor(options = {}) {
    this.sessionId = options.sessionId || '';
    this.keepRecent = Math.max(2, options.keepRecent || 6);
    this.maxSummaryChars = options.maxSummaryChars || 2400;
    this.recent = [];     // { turnId, question, answer, at, from }
    this.summaries = [];  // compacted text strings
    this.totalTurns = 0;
    this.oldestAt = null;
  }

  addTurn({ turnId, question, answer, status, at = Date.now() }) {
    this.totalTurns++;
    if (this.oldestAt == null) this.oldestAt = at;
    if (question == null && answer == null) return;
    this.recent.push({
      turnId: turnId || null,
      question: String(question ?? ''),
      answer: String(answer ?? ''),
      at,
      from: status || 'flux',
    });
    // Slide excess recent turns into the compact summary.
    if (this.recent.length > this.keepRecent + 2) {
      const overflow = this.recent.splice(0, this.recent.length - this.keepRecent);
      const chunk = overflow
        .map((t) => (t.question ? `Q: ${t.question}\nA: ${t.answer}` : `A: ${t.answer}`))
        .filter(Boolean)
        .join('\n');
      if (chunk) this.summaries.push(chunk);
    }
    this.#compactSummaries();
  }

  #compactSummaries() {
    // Bounded: collapse all pending summaries into a single blob, then cap its
    // size. Older content (the front) is dropped first.
    if (!this.summaries.length) return;
    if (this.summaries.length > 1) {
      this.summaries = [this.summaries.join('\n')];
    }
    if (this.summaries[0].length > this.maxSummaryChars) {
      const suffix = ' …(earlier turns truncated)';
      const budget = Math.max(0, this.maxSummaryChars - suffix.length);
      this.summaries = [this.summaries[0].slice(0, budget) + suffix];
    }
  }

  // System-level context string describing the conversation so far.
  compileContextForPrompt({ maxRecent = this.keepRecent } = {}) {
    const parts = [];
    // Newest turns first (recent is kept oldest→newest in memory).
    const recents = this.recent.slice(-maxRecent).reverse();
    if (recents.length) {
      parts.push('Conversation so far (most recent first):');
      for (const t of recents) {
        if (t.question) parts.push(`Q: ${t.question}\nA: ${t.answer}`);
        else if (t.answer) parts.push(`A: ${t.answer}`);
      }
    }
    if (this.summaries.length) {
      parts.push('Earlier in this interview:');
      parts.push(this.summaries.join('\n'));
    }
    return parts.join('\n');
  }

  getContext() {
    return {
      sessionId: this.sessionId,
      totalTurns: this.totalTurns,
      recent: this.recent.slice(-this.keepRecent),
      summaries: this.summaries.slice(),
      oldestAt: this.oldestAt,
    };
  }

  reset() {
    this.recent = [];
    this.summaries = [];
    this.totalTurns = 0;
    this.oldestAt = null;
  }

  snapshot() {
    const { recent, summaries, ...rest } = this.getContext();
    return {
      ...rest,
      recent,
      summaries,
      summaryChars: summaries.reduce((a, s) => a + s.length, 0),
    };
  }
}

module.exports = { ConversationManager };