import test from 'node:test';
import assert from 'node:assert/strict';
import { defineTool } from '../src/tools/define-tool.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';

// Models sometimes emit nested arguments as JSON strings. defineTool should
// coerce them to the schema's declared types before the tool runs.

test('coerces a stringified array to an array', async () => {
  let received;
  const tool = defineTool({
    name: 'probe',
    description: 'probe',
    parameters: {
      type: 'object',
      properties: { edits: { type: 'array', items: { type: 'object' } } },
    },
    execute: async (args) => {
      received = args;
      return { output: 'ok' };
    },
  });
  await tool.run({ edits: '[{"path":"a","oldString":"x","newString":"y"}]' });
  assert.ok(Array.isArray(received.edits), 'edits should be an array');
  assert.equal(received.edits[0].path, 'a');
});

test('coerces stringified nested objects and scalar types', async () => {
  let received;
  const tool = defineTool({
    name: 'probe2',
    description: 'probe2',
    parameters: {
      type: 'object',
      properties: {
        opts: { type: 'object', properties: { deep: { type: 'boolean' }, n: { type: 'integer' } } },
        count: { type: 'integer' },
        all: { type: 'boolean' },
      },
    },
    execute: async (args) => {
      received = args;
      return { output: 'ok' };
    },
  });
  await tool.run({ opts: '{"deep":true,"n":3}', count: '5', all: 'true' });
  assert.equal(received.opts.deep, true);
  assert.equal(received.opts.n, 3);
  assert.equal(received.count, 5);
  assert.equal(received.all, true);
});

test('leaves non-JSON strings untouched', async () => {
  let received;
  const tool = defineTool({
    name: 'probe3',
    description: 'probe3',
    parameters: { type: 'object', properties: { text: { type: 'string' }, content: { type: 'string' } } },
    execute: async (args) => {
      received = args;
      return { output: 'ok' };
    },
  });
  await tool.run({ text: '[not json', content: '{"a":1}' });
  assert.equal(received.text, '[not json');
  assert.equal(received.content, '{"a":1}');
});

test('patch accepts a stringified edits array end to end', async () => {
  const sandbox = path.join(os.tmpdir(), `agent-coerce-${Date.now()}`);
  await fs.ensureDir(sandbox);
  await fs.writeFile(path.join(sandbox, 'p.txt'), 'alpha\nbeta\n', 'utf8');

  const registry = new ToolRegistry({ cwd: sandbox, config: {} });
  const result = await registry.execute('patch', {
    edits: '[{"path":"p.txt","oldString":"alpha","newString":"ALPHA"}]',
  });
  assert.equal(result.metadata.error, undefined, result.output);
  assert.equal(await fs.readFile(path.join(sandbox, 'p.txt'), 'utf8'), 'ALPHA\nbeta\n');
  await fs.remove(sandbox);
});

test('patch applies repeated edits to one file sequentially', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-patch-sequential-'));
  try {
    const file = path.join(sandbox, 'p.txt');
    await fs.writeFile(file, 'alpha beta', 'utf8');
    const registry = new ToolRegistry({ cwd: sandbox, config: {} });
    const result = await registry.execute('patch', {
      edits: [
        { path: 'p.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'p.txt', oldString: 'beta', newString: 'BETA' },
      ],
    });
    assert.equal(result.metadata.error, undefined, result.output);
    assert.equal(await fs.readFile(file, 'utf8'), 'ALPHA BETA');
    assert.equal(result.metadata.touched.length, 1);
  } finally {
    await fs.remove(sandbox);
  }
});

test('patch validates every edit before writing any file', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-patch-atomic-'));
  try {
    const file = path.join(sandbox, 'p.txt');
    await fs.writeFile(file, 'alpha beta', 'utf8');
    const registry = new ToolRegistry({ cwd: sandbox, config: {} });
    const result = await registry.execute('patch', {
      edits: [
        { path: 'p.txt', oldString: 'alpha', newString: 'ALPHA' },
        { path: 'p.txt', oldString: 'missing', newString: 'MISSING' },
      ],
    });
    assert.equal(result.metadata.error, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha beta');
  } finally {
    await fs.remove(sandbox);
  }
});

test('task tool is permission gated and bounds parallel sub-agents', async () => {
  const registry = new ToolRegistry({ config: {} });
  registry.setSubagent(async () => 'done');
  const task = registry.get('task');
  assert.equal(task.mutating, true);
  await assert.rejects(
    () => task.run({ tasks: Array.from({ length: 5 }, () => ({ prompt: 'investigate' })) }),
    /At most 4 sub-agents/,
  );
});
