const COMMANDS = [
  { id: 'start-interview', phrases: ['start interview', 'start interview mode'], requiresConfirmation: false },
  { id: 'stop-interview', phrases: ['stop interview', 'end interview'], requiresConfirmation: false },
  { id: 'mute', phrases: ['mute', 'stop listening'], requiresConfirmation: false },
  { id: 'unmute', phrases: ['unmute', 'listen'], requiresConfirmation: false },
  { id: 'show-status', phrases: ['show status', 'system status', 'system health'], requiresConfirmation: false },
  { id: 'take-screenshot', phrases: ['take screenshot', 'capture screen'], requiresConfirmation: true },
  { id: 'set-reminder', phrases: ['set reminder', 'remind me'], requiresConfirmation: true },
];

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function resolveCommand(text) {
  const value = normalize(text);
  if (!value) return null;
  return COMMANDS.find(command => command.phrases.some(phrase => value.includes(phrase))) || null;
}

export function listCommands() {
  return COMMANDS.map(command => ({ ...command, phrases: [...command.phrases] }));
}

export function requiresConfirmation(commandId) {
  return Boolean(COMMANDS.find(command => command.id === commandId)?.requiresConfirmation);
}
