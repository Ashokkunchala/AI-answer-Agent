import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommand, requiresConfirmation } from './command-registry.js';
import { CommandHistory } from './command-history.js';
import { PersonalityManager } from './personality-manager.js';
import { ProactiveEngine } from './proactive-engine.js';

test('resolves safe and confirmed commands', () => {
  assert.equal(resolveCommand('start interview')?.id, 'start-interview');
  assert.equal(resolveCommand('take screenshot')?.id, 'take-screenshot');
  assert.equal(requiresConfirmation('take-screenshot'), true);
});

test('command history is bounded', () => {
  const history = new CommandHistory({ maxEntries: 2 });
  history.add({ command: 'one' });
  history.add({ command: 'two' });
  history.add({ command: 'three' });
  assert.deepEqual(history.list().map(x => x.command), ['two', 'three']);
});

test('proactive suggestions are opt-in', () => {
  const off = new PersonalityManager();
  const engine = new ProactiveEngine({ personality: off });
  assert.equal(engine.suggest({ event: 'interview-started' }), null);

  const on = new PersonalityManager({ proactive: true });
  const enabled = new ProactiveEngine({ personality: on });
  assert.equal(enabled.suggest({ event: 'interview-started' }).event, 'interview-started');
});
