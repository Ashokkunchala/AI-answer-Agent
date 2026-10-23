import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { AgentCore } from '../src/core/agent-core.js';

async function createCore(config) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-core-safety-'));
  const core = new AgentCore({ cwd, config: { tools: true, checkpoints: false, ...config }, client: {} });
  return { cwd, core, session: core.getOrCreateSession('safety-session') };
}

test('ask mode without a permission handler denies file mutations', async () => {
  const { cwd, core, session } = await createCore({ permissionMode: 'ask', autoApprove: false });
  try {
    const events = [];
    await core.executeToolCall(session, {
      name: 'write', args: { path: 'new.txt', content: 'blocked' }, id: 'call-1', onEvent: (e) => events.push(e),
    });
    assert.equal(await fs.pathExists(path.join(cwd, 'new.txt')), false);
    assert.ok(events.some((e) => e.type === 'tool_end' && e.result?.metadata?.denied));
  } finally {
    await fs.remove(cwd);
  }
});

test('a false permission callback result is a denial', async () => {
  const { cwd, core, session } = await createCore({ permissionMode: 'ask', autoApprove: false });
  try {
    core._onPermission = async () => false;
    await core.executeToolCall(session, { name: 'write', args: { path: 'new.txt', content: 'blocked' }, id: 'call-2' });
    assert.equal(await fs.pathExists(path.join(cwd, 'new.txt')), false);
  } finally {
    await fs.remove(cwd);
  }
});

test('sub-agents retain approval checks and cannot recursively spawn more agents', async () => {
  const { cwd, core } = await createCore({ permissionMode: 'ask', autoApprove: false, streaming: false, autoCheck: false });
  try {
    let calls = 0;
    core.client = {
      async chat({ tools }) {
        calls++;
        assert.equal(tools.some((tool) => tool.function?.name === 'task'), false);
        if (calls === 1) return { choices: [{ message: { tool_calls: [{ id: 'sub-write', function: { name: 'write', arguments: JSON.stringify({ path: 'sub.txt', content: 'blocked' }) } }] } }] };
        return { choices: [{ message: { content: 'done' } }] };
      },
    };
    let approvals = 0;
    core._onPermission = async () => { approvals++; return 'deny'; };
    const result = await core.runSubagent({ prompt: 'write a file', subagent_type: 'build' });
    assert.equal(result, 'done');
    assert.equal(approvals, 1);
    assert.equal(await fs.pathExists(path.join(cwd, 'sub.txt')), false);
  } finally {
    await fs.remove(cwd);
  }
});

test('concurrent permission requests are presented one at a time', async () => {
  const { cwd, core } = await createCore({ permissionMode: 'ask' });
  try {
    let active = 0;
    let maxActive = 0;
    core._onPermission = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return 'deny';
    };
    const results = await Promise.all([
      core.requestPermission({ name: 'write' }),
      core.requestPermission({ name: 'delete' }),
      core.requestPermission({ name: 'bash' }),
    ]);
    assert.deepEqual(results, ['deny', 'deny', 'deny']);
    assert.equal(maxActive, 1);
  } finally {
    await fs.remove(cwd);
  }
});

test('automatic checks obey shell approval mode', async () => {
  const { cwd, core } = await createCore({ permissionMode: 'ask', autoApprove: false });
  try {
    await fs.writeJson(path.join(cwd, 'package.json'), { scripts: { test: 'node -e "process.exit(0)"' } });
    const events = [];
    const result = await core.runPostCheck((event) => events.push(event));
    assert.equal(result.skipped, true);
    assert.equal(events.some((event) => event.type === 'check_start'), false);
  } finally {
    await fs.remove(cwd);
  }
});
