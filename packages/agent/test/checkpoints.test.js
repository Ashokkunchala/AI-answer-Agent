import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { CheckpointManager, affectedPaths } from '../src/session/checkpoints.js';

test('affectedPaths returns correct paths for various tools', () => {
  const cwd = process.platform === 'win32' ? 'C:\\home\\user\\project' : '/home/user/project';

  // write tool
  const writePaths = affectedPaths(cwd, 'write', { path: 'file.txt' });
  assert.deepEqual(writePaths, [path.join(cwd, 'file.txt')]);

  // edit tool
  const editPaths = affectedPaths(cwd, 'edit', { path: 'src/main.js' });
  assert.deepEqual(editPaths, [path.join(cwd, 'src/main.js')]);

  // patch with edits
  const patchPaths = affectedPaths(cwd, 'patch', {
    edits: [
      { path: 'a.txt', oldString: 'x', newString: 'y' },
      { path: 'b.txt', oldString: 'x', newString: 'y' },
    ],
  });
  assert.deepEqual(patchPaths.sort(), [path.join(cwd, 'a.txt'), path.join(cwd, 'b.txt')].sort());

  // move tool
  const movePaths = affectedPaths(cwd, 'move', { from: 'old.txt', to: 'new.txt' });
  assert.deepEqual(movePaths.sort(), [path.join(cwd, 'old.txt'), path.join(cwd, 'new.txt')].sort());

  // bash tool returns empty (no file tracking)
  const bashPaths = affectedPaths(cwd, 'bash', { command: 'ls' });
  assert.deepEqual(bashPaths, []);
});

test('CheckpointManager creates and restores snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'test-session';

    // Create test files
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'file1.txt'), 'original content 1', 'utf8');
    await fs.writeFile(path.join(dir, 'file2.txt'), 'original content 2', 'utf8');

    // Snapshot before
    const beforePaths = [path.join(dir, 'file1.txt'), path.join(dir, 'file2.txt')];
    const snapshot = await cm.snapshot(beforePaths);
    assert.equal(snapshot[beforePaths[0]].existed, true);
    assert.equal(Buffer.from(snapshot[beforePaths[0]].content, 'base64').toString(), 'original content 1');
    assert.equal(snapshot[beforePaths[1]].existed, true);
    assert.equal(Buffer.from(snapshot[beforePaths[1]].content, 'base64').toString(), 'original content 2');

    // Modify files
    await fs.writeFile(path.join(dir, 'file1.txt'), 'modified content 1', 'utf8');
    await fs.remove(path.join(dir, 'file2.txt'));

    // Apply snapshot (restore)
    await cm.apply(snapshot);

    // Verify restored
    const restored1 = await fs.readFile(path.join(dir, 'file1.txt'), 'utf8');
    const restored2 = await fs.readFile(path.join(dir, 'file2.txt'), 'utf8');
    assert.equal(restored1, 'original content 1');
    assert.equal(restored2, 'original content 2');
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager wrap records checkpoint', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-wrap-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'test-session';

    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'test.txt'), 'before', 'utf8');

    const { result, checkpoint } = await cm.wrap(sessionId, {
      label: 'write',
      paths: [path.join(dir, 'test.txt')],
      tool: 'write',
    }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'after', 'utf8');
      return { output: 'done' };
    });

    assert.ok(checkpoint);
    assert.equal(checkpoint.label, 'write');
    assert.equal(checkpoint.paths[0], path.join(dir, 'test.txt'));
    assert.equal(Buffer.from(checkpoint.before[path.join(dir, 'test.txt')].content, 'base64').toString(), 'before');
    assert.equal(Buffer.from(checkpoint.after[path.join(dir, 'test.txt')].content, 'base64').toString(), 'after');
    assert.equal(result.output, 'done');

    // Verify persisted
    const list = await cm.list(sessionId);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, checkpoint.id);
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager undo and redo', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-undo-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'test-session';

    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'test.txt'), 'v1', 'utf8');

    // First edit
    await cm.wrap(sessionId, { label: 'edit', paths: [path.join(dir, 'test.txt')], tool: 'edit' }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'v2', 'utf8');
    });

    // Second edit
    await cm.wrap(sessionId, { label: 'edit', paths: [path.join(dir, 'test.txt')], tool: 'edit' }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'v3', 'utf8');
    });

    // Verify current state is v3
    let content = await fs.readFile(path.join(dir, 'test.txt'), 'utf8');
    assert.equal(content, 'v3');

    // Undo last edit (should be v2)
    const undone = await cm.undo(sessionId);
    assert.ok(undone);
    content = await fs.readFile(path.join(dir, 'test.txt'), 'utf8');
    assert.equal(content, 'v2');

    // Redo (should be v3 again)
    const redone = await cm.redo(sessionId);
    assert.ok(redone);
    content = await fs.readFile(path.join(dir, 'test.txt'), 'utf8');
    assert.equal(content, 'v3');
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager rewind reverts multiple checkpoints', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-rewind-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'test-session';

    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'test.txt'), 'v1', 'utf8');

    // Three edits
    await cm.wrap(sessionId, { label: 'edit1', paths: [path.join(dir, 'test.txt')], tool: 'edit' }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'v2', 'utf8');
    });
    await cm.wrap(sessionId, { label: 'edit2', paths: [path.join(dir, 'test.txt')], tool: 'edit' }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'v3', 'utf8');
    });
    await cm.wrap(sessionId, { label: 'edit3', paths: [path.join(dir, 'test.txt')], tool: 'edit' }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'v4', 'utf8');
    });

    // Rewind 2 (should go back to v2)
    const applied = await cm.rewind(sessionId, 2);
    assert.equal(applied.length, 2);

    const content = await fs.readFile(path.join(dir, 'test.txt'), 'utf8');
    assert.equal(content, 'v2');

    // List should have only 1 checkpoint left
    const list = await cm.list(sessionId);
    assert.equal(list.length, 1);
    assert.equal(list[0].label, 'edit1');
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager disabled mode skips snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-disabled-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: false });
    const sessionId = 'test-session';

    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, 'test.txt'), 'before', 'utf8');

    const result = await cm.wrap(sessionId, {
      label: 'write',
      paths: [path.join(dir, 'test.txt')],
      tool: 'write',
    }, async () => {
      await fs.writeFile(path.join(dir, 'test.txt'), 'after', 'utf8');
      return { output: 'done' };
    });

    // Should not create checkpoint when disabled
    assert.equal(result.output, 'done');

    const list = await cm.list(sessionId);
    assert.equal(list.length, 0);
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager handles empty paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-empty-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'test-session';

    const result = await cm.wrap(sessionId, {
      label: 'bash',
      paths: [],
      tool: 'bash',
    }, async () => {
      return { output: 'command output' };
    });

    assert.equal(result.output, 'command output');

    const list = await cm.list(sessionId);
    assert.equal(list.length, 0);
  } finally {
    await fs.remove(dir);
  }
});

test('CheckpointManager restores binary files and directory trees without corrupting bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-binary-dir-'));
  try {
    const cm = new CheckpointManager({ cwd: dir, enabled: true });
    const sessionId = 'sub:windows-safe-id';
    const folder = path.join(dir, 'assets');
    const binary = path.join(folder, 'image.bin');
    await fs.ensureDir(folder);
    const originalBytes = Buffer.from([0, 255, 1, 128, 42]);
    await fs.writeFile(binary, originalBytes);

    const { checkpoint } = await cm.wrap(sessionId, {
      label: 'delete directory', paths: [folder], tool: 'delete',
    }, async () => {
      await fs.remove(folder);
      return { output: 'deleted' };
    });
    assert.ok(checkpoint);
    assert.equal(await fs.pathExists(folder), false);
    assert.ok(cm.file(sessionId).startsWith(path.join(dir, '.agent', 'checkpoints')));

    await cm.undo(sessionId);
    assert.deepEqual(await fs.readFile(binary), originalBytes);
  } finally {
    await fs.remove(dir);
  }
});

test('checkpoint storage encodes session IDs as safe single filenames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cp-safe-id-'));
  try {
    const cm = new CheckpointManager({ cwd: dir });
    const filename = cm.file('../../outside');
    assert.equal(path.dirname(filename), path.join(dir, '.agent', 'checkpoints'));
  } finally {
    await fs.remove(dir);
  }
});
