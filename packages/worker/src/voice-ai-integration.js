/**
 * Voice -> AI integration contract.
 * Keeps voice transport separate from model/provider details. The desktop
 * client sends normalized transcript + context; the Worker decides whether
 * the request is an answer, action, research task, or another agent mode.
 */

function buildVoiceRequest({ text, intent = null, context = {}, sessionId = null }) {
  return {
    input: String(text || '').trim(),
    source: 'voice',
    intent,
    sessionId,
    context: {
      ...context,
      interactionMode: 'voice'
    }
  };
}

function voiceSystemInstructions() {
  return [
    'You are the voice interface for AI-answer-Agent.',
    'Treat the transcript as user speech and preserve its intent.',
    'Prefer concise spoken responses unless the user requests detail.',
    'When an action is requested, return a structured tool intent rather than inventing execution.',
    'Do not claim an action was performed unless a tool result confirms it.',
    'If the transcript is ambiguous, ask one short clarification question.'
  ].join(' ');
}

module.exports = { buildVoiceRequest, voiceSystemInstructions };
