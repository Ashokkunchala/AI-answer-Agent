import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { PermissionManager } from '../src/core/permissions.js';

test('PermissionManager loads and saves rules', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-'));
  try {
    const pm = new PermissionManager({}, { cwd: dir });
    await pm.load();
    assert.deepEqual(pm.rules, { tools: {}, paths: {} });

    pm.rules.tools['write'] = 'allow';
    await pm.save();

    // Create new instance and verify persistence
    const pm2 = new PermissionManager({}, { cwd: dir });
    await pm2.load();
    assert.equal(pm2.rules.tools.write, 'allow');
  } finally {
    await fs.remove(dir);
  }
});

test('PermissionManager resetAll clears rules and file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-reset-'));
  try {
    const pm = new PermissionManager({}, { cwd: dir });
    await pm.load();
    pm.rules.tools['write'] = 'allow';
    pm.rules.tools['bash'] = 'deny';
    await pm.save();

    // Verify rules are saved
    assert.ok(await fs.pathExists(path.join(dir, '.agent', 'permissions.json')));

    // Reset all
    await pm.resetAll();
    assert.deepEqual(pm.rules, { tools: {}, paths: {} });
    assert.equal(pm.sessionAlways.size, 0);

    // File should be removed
    assert.equal(await fs.pathExists(path.join(dir, '.agent', 'permissions.json')), false);
  } finally {
    await fs.remove(dir);
  }
});

test('PermissionManager sanitizes malformed permissions file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-malformed-'));
  try {
    // Write malformed JSON (prototype pollution attempt)
    await fs.ensureDir(path.join(dir, '.agent'));
    await fs.writeJson(path.join(dir, '.agent', 'permissions.json'), {
      tools: { '__proto__': { polluted: true }, write: 'allow' },
      paths: { '__proto__': { polluted: true } },
    });

    const pm = new PermissionManager({}, { cwd: dir });
    await pm.load();

    // Prototype pollution should be prevented
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(pm.rules.tools.write, 'allow');
    // __proto__ should not be in the rules (sanitized to empty object)
    assert.deepEqual(pm.rules.tools.__proto__, {});
    assert.deepEqual(pm.rules.paths.__proto__, {});
  } finally {
    await fs.remove(dir);
  }
});

test('PermissionManager pathDecision respects deniedPaths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-paths-'));
  try {
    const config = {
      deniedPaths: ['/etc', '/root'],
      allowedPaths: ['/home/user/projects'],
    };
    const pm = new PermissionManager(config, { cwd: '/home/user/projects' });

    // Path inside denied path
    const denied = await pm.pathDecision('write', { path: '/etc/passwd' });
    assert.equal(denied, 'deny');

    // Path outside workspace and allowedPaths
    const outside = await pm.pathDecision('write', { path: '/tmp/somefile' });
    assert.equal(outside, 'outside');

    // Path inside workspace
    const inside = await pm.pathDecision('write', { path: '/home/user/projects/myfile.txt' });
    assert.equal(inside, null);
  } finally {
    await fs.remove(dir);
  }
});

test('hard denials override remembered and allowlisted tools', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-hard-deny-'));
  try {
    const pm = new PermissionManager({ allowedTools: ['write'], deniedPaths: ['private'] }, { cwd: dir });
    pm.rules.tools.write = 'allow';
    const result = await pm.check({ name: 'write', args: { path: 'private/secret.txt' }, tool: { mutating: true } });
    assert.equal(result.decision, 'deny');
    assert.equal(result.reason, 'path denied by config');

    pm.config.deniedTools = ['write'];
    const deniedTool = await pm.check({ name: 'write', args: { path: 'ordinary.txt' }, tool: { mutating: true } });
    assert.equal(deniedTool.decision, 'deny');
  } finally {
    await fs.remove(dir);
  }
});

test('saved deny rules are enforced and unified diff paths are checked', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-diff-'));
  try {
    const pm = new PermissionManager({ deniedPaths: ['secrets'] }, { cwd: dir });
    pm.rules.tools.read = 'deny';
    const deniedRead = await pm.check({ name: 'read', args: { path: 'notes.txt' }, tool: { mutating: false } });
    assert.equal(deniedRead.decision, 'deny');

    const deniedPatch = await pm.check({
      name: 'patch',
      args: { diff: '--- a/secrets/token.txt\n+++ b/secrets/token.txt\n@@ -1 +1 @@\n-old\n+new\n' },
      tool: { mutating: true },
    });
    assert.equal(deniedPatch.decision, 'deny');
    assert.equal(deniedPatch.reason, 'path denied by config');

    delete pm.rules.tools.read;
    const outsideRead = await pm.check({ name: 'read', args: { path: '../outside.txt' }, tool: { mutating: false } });
    assert.equal(outsideRead.decision, 'ask');
  } finally {
    await fs.remove(dir);
  }
});

test('denied paths cannot be reached through a workspace symlink', async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-link-workspace-'));
  const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-link-secret-'));
  try {
    const linkPath = path.join(workspace, 'linked-secrets');
    try {
      await fs.symlink(secretDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlinks are unavailable in this environment');
      throw error;
    }
    const pm = new PermissionManager({ deniedPaths: [secretDir] }, { cwd: workspace });
    const result = await pm.check({
      name: 'write', args: { path: 'linked-secrets/token.txt' }, tool: { mutating: true },
    });
    assert.equal(result.decision, 'deny');
  } finally {
    await fs.remove(workspace);
    await fs.remove(secretDir);
  }
});

test('sensitive credential files require confirmation even when tools are allowlisted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-sensitive-'));
  try {
    const pm = new PermissionManager({ permissionMode: 'allow', allowedTools: ['read'] }, { cwd: dir });
    const secret = await pm.check({ name: 'read', args: { path: '.env.production' }, tool: { mutating: false } });
    assert.equal(secret.decision, 'ask');
    assert.match(secret.reason, /credentials/);

    const example = await pm.check({ name: 'read', args: { path: '.env.example' }, tool: { mutating: false } });
    assert.equal(example.decision, 'allow');
  } finally {
    await fs.remove(dir);
  }
});

test('PermissionManager mode respects autoApprove and permissionMode', () => {
  const pm1 = new PermissionManager({ autoApprove: true });
  assert.equal(pm1.mode(), 'allow');

  const pm2 = new PermissionManager({ autoApprove: false });
  assert.equal(pm2.mode(), 'ask');

  const pm3 = new PermissionManager({ permissionMode: 'deny' });
  assert.equal(pm3.mode(), 'deny');

  const pm4 = new PermissionManager({ permissionMode: 'allow' });
  assert.equal(pm4.mode(), 'allow');

  // autoApprove true overrides permissionMode deny
  const pm5 = new PermissionManager({ autoApprove: true, permissionMode: 'deny' });
  assert.equal(pm5.mode(), 'allow');
});

test('PermissionManager check returns correct decisions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perm-check-'));
  try {
    const pm = new PermissionManager({ autoApprove: false, permissionMode: 'ask' }, { cwd: dir });
    await pm.load();

    // Read-only tool should be allowed
    const readResult = await pm.check({ name: 'read', args: { path: 'file.txt' }, tool: { mutating: false } });
    assert.equal(readResult.decision, 'allow');

    // Mutating tool with ask mode should ask
    const writeResult = await pm.check({ name: 'write', args: { path: 'file.txt', content: 'x' }, tool: { mutating: true } });
    assert.equal(writeResult.decision, 'ask');

    // Denied tool
    const pmDeny = new PermissionManager({ deniedTools: ['write'] }, { cwd: dir });
    await pmDeny.load();
    const deniedResult = await pmDeny.check({ name: 'write', args: {}, tool: { mutating: true } });
    assert.equal(deniedResult.decision, 'deny');

    // Allowed tool
    const pmAllow = new PermissionManager({ allowedTools: ['write'] }, { cwd: dir });
    await pmAllow.load();
    const allowedResult = await pmAllow.check({ name: 'write', args: {}, tool: { mutating: true } });
    assert.equal(allowedResult.decision, 'allow');
  } finally {
    await fs.remove(dir);
  }
});
