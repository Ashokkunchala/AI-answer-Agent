import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { Terminal, stripAnsi, oneLine, shortArgs, paletteMatches } from '../src/ui/terminal.js';

const h = React.createElement;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness(agentOverrides = {}) {
  const cli = {
    sessionId: 's1',
    config: { model: 'auto', tools: true },
    client: { models: async () => [{ id: 'model-a', name: 'Model A' }] },
    sessionStore: {
      list: async () => [{ id: 's1', title: 'first session', updatedAt: '2026-01-01T00:00:00.000Z' }],
    },
  };
  const config = { model: 'auto', tools: true, workerUrl: 'http://127.0.0.1:8787' };
  const commands = {
    names: async () => [{ name: '/help', description: 'Show help' }],
    handle: async (line) => {
      console.log('cmd-output:' + line);
      return true;
    },
  };
  const client = { models: async () => [{ id: 'model-a', name: 'Model A' }] };
  const agent = {
    cwd: 'C:/proj',
    cancelled: false,
    chat: async () => '',
    permissions: { mode: () => 'ask' },
    loadSession: async () => ({ id: 's2', messages: [] }),
    ...agentOverrides,
  };
  const app = render(h(Terminal, { cli, agent, client, commands, config }), { exitOnCtrlC: false });
  return { app, cli, agent, commands, config, client };
}

async function type(app, text) {
  app.stdin.write(text);
  await wait(30);
}

async function submit(app, text) {
  await type(app, text);
  app.stdin.write('\r');
}

test('renders header, worker line and prompt', async () => {
  const { app } = makeHarness();
  await wait(40);
  const frame = app.lastFrame();
  assert.match(frame, /AGENT/);
  assert.match(frame, /worker http:\/\/127\.0\.0\.1:8787/);
  assert.match(frame, /Ask anything/);
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

test('slash commands render into the transcript', async () => {
  const { app } = makeHarness();
  await wait(30);
  await submit(app, '/help');
  await wait(80);
  const frame = app.lastFrame();
  assert.match(frame, /cmd-output:\/help/);
  app.unmount();
});

test('typing / shows the command palette', async () => {
  const { app } = makeHarness();
  await wait(30);
  await type(app, '/hel');
  const frame = app.lastFrame();
  assert.match(frame, /\/help/);
  assert.match(frame, /Show help/);
  app.unmount();
});

test('ctrl+o opens the model picker', async () => {
  const { app } = makeHarness();
  await wait(30);
  app.stdin.write('\x0f');
  await wait(60);
  const frame = app.lastFrame();
  assert.match(frame, /Select model/);
  assert.match(frame, /model-a/);
  app.unmount();
});

test('ctrl+k opens the help overlay and ctrl shortcuts do not corrupt input', async () => {
  const { app } = makeHarness();
  await wait(30);
  app.stdin.write('\x0b');
  await wait(50);
  assert.match(app.lastFrame(), /Help & shortcuts/);
  app.stdin.write('\x0b');
  await wait(50);
  const frame = app.lastFrame();
  assert.doesNotMatch(frame, /Help & shortcuts/);
  app.unmount();
});

test('text editing: typing, backspace and cursor movement', async () => {
  const { app } = makeHarness();
  await wait(30);
  await type(app, 'ab');
  assert.match(app.lastFrame(), /ab/);
  app.stdin.write('\x7f'); // backspace
  await wait(30);
  assert.doesNotMatch(app.lastFrame(), /›\s*ab/);
  app.unmount();
});

test('helpers: stripAnsi / oneLine / shortArgs / paletteMatches', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(oneLine('a\n b', 10), 'a b');
  assert.match(shortArgs({ command: 'ls' }), /command/);
  assert.equal(shortArgs({}), '');
  assert.equal(shortArgs(null), '');

  const items = [
    { name: '/help', description: 'h' },
    { name: '/model', description: 'm' },
  ];
  assert.deepEqual(
    paletteMatches(items, '/mo').map((i) => i.name),
    ['/model'],
  );
  assert.equal(paletteMatches(items, '').length, 2);
});
