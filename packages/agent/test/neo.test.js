import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { NeoTerminal, stripAnsi, oneLine, paletteMatches, orderModelsForPicker, modelPriceTag, budgetSummary, activityLine, activityPhaseColor, formatTurnSummary } from '../src/ui/neo.js';
import { EVENT } from '../src/core/events.js';

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
  const config = { model: 'auto', tools: true, workerUrl: 'http://127.0.0.1:8787', maxSteps: 60 };
  const commands = {
    names: async () => [
      { name: '/help', description: 'Show help' },
      { name: '/model', description: 'Set the model' },
    ],
    handle: async (line) => {
      console.log('cmd-output:' + line);
      return true;
    },
  };
  const client = {
    health: async () => ({ ok: true, status: 200 }),
    models: async () => [{ id: 'model-a', name: 'Model A' }],
  };
  const agent = {
    cwd: 'C:/proj',
    cancelled: false,
    chat: async () => '',
    permissions: { mode: () => 'ask' },
    loadSession: async () => ({ id: 's2', messages: [] }),
    getOrCreateSession: () => ({ id: 's1', messages: [] }),
    registry: {
      list: () => ['read', 'write', 'bash'],
      describe: () => [
        { name: 'read', category: 'file', mutating: false, description: 'Read a file' },
        { name: 'bash', category: 'shell', mutating: true, description: 'Run a command' },
      ],
      get: (name) => ({
        run: async (args) => ({ title: name, output: `shell-result:${args.command}`, metadata: { code: 0 } }),
      }),
    },
    ...agentOverrides,
  };
  const app = render(h(NeoTerminal, { cli, agent, client, commands, config }), { exitOnCtrlC: false });
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

test('renders header, input box and status hints', async () => {
  const { app } = makeHarness();
  await wait(60);
  const frame = app.lastFrame();
  assert.match(frame, /agent/);
  assert.match(frame, /● online/);
  assert.match(frame, /message agent/);
  assert.match(frame, /enter send/);
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
  await wait(40);
  await submit(app, 'hi there');
  await wait(180);
  const frame = app.lastFrame();
  assert.match(frame, /hi there/);
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
  await wait(40);
  await submit(app, 'read nope');
  await wait(140);
  const frame = app.lastFrame();
  assert.match(frame, /✗/);
  assert.match(frame, /ENOENT/);
  app.unmount();
});

test('typing / shows the command palette with pseudo commands', async () => {
  const { app } = makeHarness();
  await wait(40);
  await type(app, '/re');
  const frame = app.lastFrame();
  assert.match(frame, /\/retry/);
  assert.match(frame, /Re-run the last message/);
  app.unmount();
});

test('slash commands render into the transcript', async () => {
  const { app } = makeHarness();
  await wait(40);
  await submit(app, '/help');
  await wait(80);
  assert.match(app.lastFrame(), /cmd-output:\/help/);
  app.unmount();
});

test('enter on a bare / runs the highlighted command, not "Unknown command"', async () => {
  const { app } = makeHarness();
  await wait(40);
  await type(app, '/');
  assert.match(app.lastFrame(), /\/help/); // palette opened
  app.stdin.write('\r');
  await wait(80);
  const frame = app.lastFrame();
  assert.match(frame, /cmd-output:\/help/);
  assert.doesNotMatch(frame, /Unknown command/);
  app.unmount();
});

test('ctrl+o opens the model picker', async () => {
  const { app } = makeHarness();
  await wait(40);
  app.stdin.write('\x0f');
  await wait(60);
  const frame = app.lastFrame();
  assert.match(frame, /Select model/);
  assert.match(frame, /model-a/);
  app.unmount();
});

test('ctrl+t opens the tools overlay', async () => {
  const { app } = makeHarness();
  await wait(40);
  app.stdin.write('\x14');
  await wait(60);
  const frame = app.lastFrame();
  assert.match(frame, /Tools \(2\)/);
  assert.match(frame, /bash/);
  assert.match(frame, /mutating/);
  app.unmount();
});

test('ctrl+k opens help and ctrl shortcuts do not corrupt input', async () => {
  const { app } = makeHarness();
  await wait(40);
  app.stdin.write('\x0b');
  await wait(50);
  assert.match(app.lastFrame(), /Help · keyboard/);
  app.stdin.write('\x0b');
  await wait(50);
  assert.doesNotMatch(app.lastFrame(), /Help · keyboard/);
  app.unmount();
});

test('! runs a shell command through the bash tool', async () => {
  const { app } = makeHarness();
  await wait(40);
  await submit(app, '! echo hi');
  await wait(120);
  const frame = app.lastFrame();
  assert.match(frame, /bash/);
  assert.match(frame, /shell-result:echo hi/);
  app.unmount();
});

test('up arrow recalls the previous prompt from history', async () => {
  const { app } = makeHarness();
  await wait(40);
  await submit(app, 'remember me');
  await wait(120);
  app.stdin.write('\u001b[A');
  await wait(50);
  const frame = app.lastFrame();
  assert.match(frame, /remember me/);
  app.unmount();
});

test('/retry re-runs the last message', async () => {
  let calls = 0;
  const { app } = makeHarness({
    chat: async () => {
      calls += 1;
      return `answer-${calls}`;
    },
  });
  await wait(40);
  await submit(app, 'do the thing');
  await wait(120);
  await submit(app, '/retry');
  await wait(150);
  assert.equal(calls, 2);
  assert.match(app.lastFrame(), /do the thing/);
  app.unmount();
});

test('text editing: typing, backspace and ctrl+u cut', async () => {
  const { app } = makeHarness();
  await wait(40);
  await type(app, 'abcdef');
  assert.match(app.lastFrame(), /abcdef/);
  app.stdin.write('\u0015'); // ctrl+u cuts to start
  await wait(40);
  assert.doesNotMatch(app.lastFrame(), /abcdef/);
  app.unmount();
});

test('helpers: stripAnsi / oneLine / paletteMatches', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
  assert.equal(oneLine('a\n b', 10), 'a b');
  const items = [
    { name: '/help', description: 'h' },
    { name: '/retry', description: 'r' },
  ];
  assert.deepEqual(paletteMatches(items, '/re').map((i) => i.name), ['/retry']);
  assert.equal(paletteMatches(items, '').length, 2);
});

test('model picker orders free-tier first, then cheapest, with auto on top', () => {
  const models = [
    { id: 'gateway-x', name: 'Gateway', pricing: { note: 'AI Gateway billing' } },
    { id: 'pricey', name: 'Pricey', pricing: { in: 4, out: 4 } },
    { id: 'cheap', name: 'Cheap', pricing: { in: 0.05, out: 0.1 } },
    { id: 'pool-1', name: 'Pool', pricing: { pool: true } },
    { id: 'auto', name: 'stale auto entry' },
  ];
  const ordered = orderModelsForPicker(models).map((m) => m.id);
  assert.deepEqual(ordered, ['auto', 'pool-1', 'cheap', 'pricey', 'gateway-x']);
  assert.equal(modelPriceTag({ pricing: { pool: true } }), 'free');
  assert.equal(modelPriceTag({ pricing: { in: 0.05, out: 0.1 } }), '$0.075/M');
  assert.equal(modelPriceTag({ pricing: { note: 'gateway billing' } }), 'gateway');
});

test('budget summary renders free-tier headroom and non-free modes', () => {
  assert.equal(budgetSummary(null), '');
  assert.equal(budgetSummary({ mode: 'free', free_remaining: 9800, free_neurons_per_day: 10000 }), 'free 9.8k/10k');
  assert.equal(budgetSummary({ mode: 'saver', free_remaining: 0, free_neurons_per_day: 10000 }), 'free 0/10k · saver');
  assert.equal(
    budgetSummary({ mode: 'free', free_remaining: 9800, free_neurons_per_day: 10000, usd_month: 0.0123, budget_monthly_usd: 5 }),
    'free 9.8k/10k · $0.0123/5',
  );
  assert.equal(
    budgetSummary({ mode: 'paid', free_remaining: 0, free_neurons_per_day: 10000, usd_month: 1.5, budget_monthly_usd: 5 }),
    'free 0/10k · paid · $1.50/5',
  );
});

test('helpers: formatTurnSummary reports latency, tokens, model and routing', () => {
  assert.equal(formatTurnSummary({}), '');
  assert.equal(
    formatTurnSummary({ model: 'gemma-4-26b', usage: { total_tokens: 412 }, latency_ms: 1400, routing: { reason: 'free neuron pool (free tier first)' } }),
    '⏺ 1.4s · 412 tok · gemma-4-26b · free neuron pool (free tier first)',
  );
  assert.equal(formatTurnSummary({ model: 'auto', usage: { total_tokens: 12000 }, latency_ms: 23000 }), '⏺ 23s · 12k tok · auto');
  assert.equal(formatTurnSummary({ model: 'glm-4.7-flash' }), '⏺ glm-4.7-flash');
});

test('helpers: activityLine / activityPhaseColor', () => {
  const now = 10_000;
  assert.equal(
    activityLine({ activity: { kind: 'tool', detail: 'bash npm test', since: now - 2300 }, spin: '*', activeModel: 'gemma-4-26b', now }),
    '  * tool · bash npm test · 2.3s · via gemma-4-26b',
  );
  assert.equal(activityLine({ activity: null, spin: '*', now }), '  * working · 0.0s');
  assert.equal(
    activityLine({ activity: { kind: 'streaming', since: now - 500 }, spin: '*', chars: 128, now }),
    '  * replying · 128 chars · 0.5s',
  );
  assert.equal(
    activityLine({ activity: { kind: 'check', detail: 'npm run typecheck', since: now }, spin: '*', now }),
    '  * running check · npm run typecheck · 0.0s',
  );
  const theme = { ok: 'green', warn: 'yellow', accent: 'magenta', primary: 'cyan' };
  assert.equal(activityPhaseColor('streaming', theme), 'green');
  assert.equal(activityPhaseColor('tool', theme), 'yellow');
  assert.equal(activityPhaseColor('args', theme), 'yellow');
  assert.equal(activityPhaseColor('subagent', theme), 'magenta');
  assert.equal(activityPhaseColor('thinking', theme), 'cyan');
});

test('live activity line tracks the tool phase and routed model during a turn', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { app } = makeHarness({
    chat: async ({ onEvent }) => {
      onEvent({ type: EVENT.MODEL, model: 'gemma-4-26b' });
      onEvent({ type: EVENT.STEP, current: 2, total: 60, message: 'Planning and investigating' });
      onEvent({ type: EVENT.TOOL_START, name: 'bash', args: { command: 'npm test' } });
      await gate;
      onEvent({ type: EVENT.TOOL_END, name: 'bash', result: { output: 'ok', metadata: { code: 0 } } });
      onEvent({ type: EVENT.DONE });
      return 'done';
    },
  });
  await wait(40);
  await submit(app, 'run the tests');
  await wait(80);
  try {
    const frame = app.lastFrame();
    assert.match(frame, /tool · bash/);
    assert.match(frame, /via gemma-4-26b/);
    assert.match(frame, /gemma-4-26b · ● online · perm/);
  } finally {
    release();
    await wait(140);
    app.unmount();
  }
  assert.doesNotMatch(app.lastFrame(), /tool · bash/);
});

test('status bar shows the worker budget from /health', async () => {
  const cli = { sessionId: 's1', config: { model: 'auto', tools: true }, client: { models: async () => [] }, sessionStore: { list: async () => [] } };
  const client = {
    health: async () => ({ ok: true, status: 200, data: { budget: { mode: 'free', free_remaining: 9400, free_neurons_per_day: 10000 } } }),
    models: async () => [],
  };
  const commands = { names: async () => [], handle: async () => true };
  const agent = { cwd: 'C:/proj', chat: async () => '', permissions: { mode: () => 'ask' }, registry: { list: () => [], describe: () => [] }, getOrCreateSession: () => ({ id: 's1', messages: [] }) };
  const rendered = render(h(NeoTerminal, { cli, agent, client, commands, config: { model: 'auto', tools: true, maxSteps: 60 } }), { exitOnCtrlC: false });
  await wait(80);
  assert.match(rendered.lastFrame(), /free 9\.4k\/10k/);
  rendered.unmount();
});
