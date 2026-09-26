import { interviewMode, scoreAnswerHeuristically, likelyFollowUps } from './intelligence.js';

const MAX_SPOKEN_CHARS = 1200;

function normalize(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function unsupportedFirstPerson(answer, resume) {
  if (!resume) return [];
  const claims = normalize(answer).match(/\b(I|we)\s+(?:built|led|designed|managed|implemented|deployed|worked|created|owned)\b[^.?!]*/gi) || [];
  const source = normalize(resume).toLowerCase();
  return claims.filter((claim) => {
    const terms = claim.toLowerCase().split(/\W+/).filter((term) => term.length > 4).slice(0, 6);
    return terms.length > 1 && terms.filter((term) => source.includes(term)).length < 2;
  });
}

export function buildGroundedAnswer({ question, answer, resume, jobDesc, taskType }) {
  const cleanQuestion = normalize(question);
  const cleanAnswer = normalize(answer);
  const mode = interviewMode(cleanQuestion, taskType || 'interview');
  const flags = [];

  if (!cleanAnswer) flags.push('empty_answer');
  if (cleanAnswer.length > MAX_SPOKEN_CHARS) flags.push('too_long_for_live_delivery');
  if (unsupportedFirstPerson(cleanAnswer, resume).length) flags.push('possible_unsupported_experience');
  if (jobDesc && cleanQuestion && !cleanAnswer.toLowerCase().includes(cleanQuestion.toLowerCase().split(' ')[0])) {
    flags.push('review_relevance');
  }

  const quality = scoreAnswerHeuristically(cleanQuestion, cleanAnswer, { resume, jobDesc, taskType: taskType || mode });
  const followups = likelyFollowUps(cleanQuestion, mode);

  return {
    answer: cleanAnswer.length > MAX_SPOKEN_CHARS
      ? `${cleanAnswer.slice(0, MAX_SPOKEN_CHARS - 1).trim()}…`
      : cleanAnswer,
    mode,
    quality,
    followups,
    guard_flags: flags,
    grounding: flags.includes('possible_unsupported_experience') ? 'review' : 'ok',
  };
}
