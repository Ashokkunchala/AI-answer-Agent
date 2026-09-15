// question-detector.js — lightweight question/intent detection for the AI
// gate. Pure heuristics: no LLM round-trip, sub-millisecond cost.
//
// Decides whether a finalized transcript is worth feeding to the AI agent
// (as opposed to a casual remark that should stay conversational).
'use strict';

const INTERROGATIVES = [
  'who', 'what', 'where', 'when', 'why', 'how', 'which', 'whom', 'whose',
];
const YESNO_STARTS = [
  'can', 'could', 'would', 'will', 'do', 'does', 'did', 'is', 'are', 'am',
  'should', 'shall', 'may', 'might', 'have', 'has', 'had',
];
const COMMAND_VERBS = [
  'explain', 'describe', 'tell', 'walk', 'elaborate', 'define', 'clarify',
  'summarize', 'summarise', 'justify', 'detail', 'compare', 'outline',
  'state', 'give', 'list', 'what are', 'what is', 'what\'s',
];
const COMPARE_PATTERNS = [
  'difference between', 'what is the difference', 'compare ',
  'vs', 'versus', 'pros and cons', 'trade-off', 'tradeoff',
];
const CUE_WORDS = [
  'how do', 'how does', 'how would', 'how can', 'what is', "what's",
  'what are', 'what does', 'what do', 'why is', 'why do', 'why does',
  'can you', 'could you', 'would you', 'will you', 'do you', 'have you',
  'could you walk', 'can you explain', 'tell me', 'walk me through',
  'explain the', 'explain how', 'elaborate on', 'describe the', 'define ',
  'in your own words', 'what happens', 'what would you', 'what do you'
];

// Strip punctuation/normalize for matching.
function normalize(text) {
  return (text || '').toLowerCase().replace(/[?.!,\u2019']+/g, '').trim();
}

function firstWord(text) {
  const m = (text || '').trim().toLowerCase().match(/^[a-z][a-z']*/);
  return m ? m[0] : '';
}

function startsWithPhrase(text, phrases) {
  const t = normalize(text);
  for (const p of phrases) {
    if (t.startsWith(p)) return { matched: p, value: t };
  }
  return null;
}

function midPhrase(text, phrases) {
  const t = normalize(text);
  for (const p of phrases) {
    if (t.includes(p)) return { matched: p, value: t };
  }
  return null;
}

// Returns { isQuestion, kind, confidence, reason }.
function detectQuestion(transcript) {
  const raw = (transcript || '').trim();
  if (raw.length < 3) return { isQuestion: false, kind: 'none', confidence: 0, reason: 'too-short' };

  let confidence = 0;
  let kind = 'statement';
  let reason = '';

  // Explicit question mark is a strong signal but not required.
  const hasQM = /[?？]/.test(raw);

  const fw = firstWord(raw);
  const inter = startsWithPhrase(raw, INTERROGATIVES);
  const yesno = fw && YESNO_STARTS.includes(fw);
  const interrupted = !!(inter || yesno);
  if (inter) { kind = 'interrogative'; confidence = 0.62; reason = 'interrogative:' + inter.matched; }
  if (yesno) { kind = 'yesno'; confidence = 0.6; reason = 'yesno:' + fw; }

  const cue = startsWithPhrase(raw, CUE_WORDS);
  if (cue && confidence < 0.7) { kind = confidence > 0.5 ? kind : (kind === 'statement' ? 'soft-question' : kind); confidence = Math.max(confidence, 0.58); reason = 'cue:' + cue.matched; }

  const cmds = startsWithPhrase(raw, COMMAND_VERBS);
  if (cmds) { kind = 'command'; confidence = Math.max(confidence, 0.68); reason = 'command:' + cmds.matched; }

  const cmp = midPhrase(raw, COMPARE_PATTERNS);
  if (cmp) { kind = 'compare'; confidence = Math.max(confidence, 0.74); reason = 'compare:' + cmp.matched; }

  // Second-person / actionable phrasing anywhere in the middle.
  const mid = midPhrase(raw, ['tell me about', 'walk me through', 'explain to me', 'what do you mean', 'how would you go', 'describe how you would']);
  if (mid) { confidence = Math.max(confidence, 0.6); kind = kind === 'statement' ? 'soft-question' : kind; reason = 'mid:' + mid.matched; }

  // '?' boosts whichever hypothesis we have, or implies a question on its own.
  if (hasQM) {
    confidence = Math.min(1, confidence + 0.25);
    if (kind === 'statement') { kind = 'punctuated'; confidence = Math.max(confidence, 0.45); reason = 'question-mark'; }
    else if (kind === 'soft-question') { kind = 'question'; reason = 'cue+mark'; }
  }

  const isQuestion = confidence >= 0.45;
  if (!isQuestion) {
    return { isQuestion: false, kind, confidence, reason: reason || 'below-threshold' };
  }
  return { isQuestion: true, kind, confidence: Math.round(confidence * 100) / 100, reason };
}

module.exports = { detectQuestion, normalize, firstWord };