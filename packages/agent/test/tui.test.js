import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { App, stripAnsi, oneLine, shortArgs } from '../src/ui/tui.js';

const h = React.createElement;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness(agentOverrides = {}) {
  const cli = { sessionId: 's1', config: { model: 'auto', tools: true } };
  const config = { model: 'auto', tools: true, workerUrl: 'http://127.0.0.1:8787' };
  const commands = {
    handle: async (line) => {
      console.log('cmd-output:' + line);
      return true;
    },
  };
  const agent = { cwd: 'C:/proj', cancelled: false, chat: async () => '', ...agentOverrides };
  const app = render(h(App, { cli, agent, commands, config }), { exitOnCtrlC: false });
  return { app, cli, agent, commands, config };
}

async function submit(app, text) {
  app.stdin.write(text);
  await wait(30);
  app.stdin.write('\r');
}

test('renders prompt and status bar', async () => {
  const { app } = makeHarness();
  await wait(40);
  const frame = app.lastFrame();
  assert.match(frame, /Ask anything/);
  assert.match(frame, /auto · C:\/proj/);
  app.unmount();
});

test('streams assistant text and renders tool call lifecycle', async () => {
  const { app } = makeHarness({
    chat: async ({ onEvent }) => {
      onEvent({ type: 'content', text: 'Hello ' });
      await wait(5);
      onEvent({ type: 'content', text: 'world' });
      onEvent({ type: 'tool_start', name: 'bash', args: { command: 'ls' }, id: 'c1' });
      await wait(15);
      onEvent({ type: 'tool_end', name: 'bash', result: { output: 'a.txt\nb.txt', metadata: {} } });
      onEvent({ type: 'content', text: ' done' });
      return ' done';
    },
  });
  await wait(30);
  await submit(app, 'hi there');
  await wait(160);
  const frame = app.lastFrame();
  assert.match(frame, /› hi there/);
  assert.match(frame, /Hello world/);
  assert.match(frame, /bash/);
  assert.match(frame, /a\.txt/);
  assert.match(frame, /done/);
  app.unmount();
});

test('tool errors are marked distinctly', async () => {
  const { app } = makeHarness({
    chat: async ({ onEvent }) => {
      onEvent({ type: 'tool_start', name: 'read', args: { path: 'nope' }, id: 'c1' });
      await wait(10);
      onEvent({ type: 'tool_end', name: 'read', result: { output: 'Error: ENOENT', metadata: { error: true } } });
      return '';
    },
  });
  await wait(30);
  await submit(app, 'read nope');
  await wait(120);
  const frame = app.lastFrame();
  assert.match(frame, /✗/);
  assert.match(frame, /ENOENT/);
  app.unmount();
});

test('slash commands are captured into an output item', async () => {
  const { app } = makeHarness();
  await wait(30);
  await submit(app, '/help');
  await wait(70);
  const frame = app.lastFrame();
  assert.match(frame, /cmd-output:\/help/);
  app.unmount();
});

test('helpers: stripAnsi / oneLine / shortArgs', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(oneLine('a\n b', 10), 'a b');
  assert.match(shortArgs({ command: 'ls' }), /command/);
  assert.equal(shortArgs({}), '');
  assert.equal(shortArgs(null), '');
});
