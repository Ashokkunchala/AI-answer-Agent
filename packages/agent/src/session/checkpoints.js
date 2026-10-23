import fs from 'fs-extra';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolvePath, displayPath } from '../tools/path-utils.js';
import { parseUnifiedDiff } from '../tools/patch.js';
import { storageFilename } from '../utils/ids.js';

const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024;
const MAX_CHECKPOINT_ENTRIES = 2000;

// Compute the file paths a tool call will touch, before it runs. Used to
// snapshot file state so edits can be undone.
export function affectedPaths(cwd, name, args = {}) {
  const out = new Set();
  const add = (p) => { if (p) out.add(resolvePath(cwd, p)); };
  if (name === 'bash') return [];
  if (args.path) add(args.path);
  if (args.from) add(args.from);
  if (args.to) add(args.to);
  if (Array.isArray(args.edits)) for (const e of args.edits) add(e.path);
  if (Array.isArray(args.files)) for (const f of args.files) add(f);
  if (args.diff && typeof args.diff === 'string') {
    for (const file of parseUnifiedDiff(args.diff)) add(file.path);
  }
  return [...out];
}

// File-snapshot checkpoints. Each checkpoint records the `before` and `after`
// content of every file a mutating tool touched, so edits can be reverted and
// re-applied. Persisted per session under .agent/checkpoints/<session>.json.
export class CheckpointManager {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.enabled = opts.enabled !== false;
    this.dir = opts.dir || path.join(this.cwd, '.agent', 'checkpoints');
    this.cache = new Map();
    this.redoStack = new Map();
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.dir = path.join(cwd, '.agent', 'checkpoints');
    this.cache.clear();
  }

  file(sessionId) {
    return path.join(this.dir, storageFilename(sessionId));
  }

  async load(sessionId) {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId);
    let list = [];
    try {
      if (await fs.pathExists(this.file(sessionId))) list = await fs.readJson(this.file(sessionId));
    } catch (e) {
      console.debug?.(`Failed to load checkpoints: ${e.message}`);
      list = [];
    }
    this.cache.set(sessionId, list);
    return list;
  }

  async persist(sessionId) {
    try {
      await fs.ensureDir(this.dir);
      await fs.writeJson(this.file(sessionId), this.cache.get(sessionId) || [], { spaces: 2 });
    } catch (e) {
      console.debug?.(`Failed to persist checkpoints: ${e.message}`);
      /* best effort */
    }
  }

  async snapshot(paths) {
    const map = {};
    let totalBytes = 0;
    let totalEntries = 0;
    const account = (size) => {
      totalBytes += size;
      totalEntries++;
      if (totalBytes > MAX_CHECKPOINT_BYTES) {
        throw new Error(`Checkpoint exceeds the ${MAX_CHECKPOINT_BYTES / (1024 * 1024)} MiB safety limit.`);
      }
      if (totalEntries > MAX_CHECKPOINT_ENTRIES) {
        throw new Error(`Checkpoint exceeds the ${MAX_CHECKPOINT_ENTRIES} entry safety limit.`);
      }
    };

    const visitDirectory = async (root, relative, entries) => {
      const current = relative ? path.join(root, relative) : root;
      const children = await fs.readdir(current, { withFileTypes: true });
      for (const child of children) {
        const rel = relative ? path.join(relative, child.name) : child.name;
        const fullPath = path.join(root, rel);
        const stat = await fs.lstat(fullPath);
        if (stat.isSymbolicLink()) {
          const target = await fs.readlink(fullPath);
          account(Buffer.byteLength(target));
          entries.push({ path: rel, kind: 'symlink', target });
        } else if (stat.isDirectory()) {
          account(0);
          entries.push({ path: rel, kind: 'directory' });
          await visitDirectory(root, rel, entries);
        } else if (stat.isFile()) {
          account(stat.size);
          const content = await fs.readFile(fullPath);
          entries.push({ path: rel, kind: 'file', content: content.toString('base64') });
        }
      }
    };

    for (const p of paths) {
      let stat;
      try { stat = await fs.lstat(p); } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
          map[p] = { existed: false };
          continue;
        }
        throw error;
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(p);
        account(Buffer.byteLength(target));
        map[p] = { existed: true, kind: 'symlink', target };
      } else if (stat.isDirectory()) {
        account(0);
        const entries = [];
        await visitDirectory(p, '', entries);
        map[p] = { existed: true, kind: 'directory', entries };
      } else if (stat.isFile()) {
        account(stat.size);
        const content = await fs.readFile(p);
        map[p] = { existed: true, kind: 'file', content: content.toString('base64') };
      } else {
        map[p] = { existed: false };
      }
    }
    return map;
  }

  // Run `fn` and record the before/after state of `paths` as a checkpoint.
  async wrap(sessionId, { label, paths, tool }, fn) {
    if (!this.enabled || !paths?.length) return fn();
    const before = await this.snapshot(paths);
    const result = await fn();
    const after = await this.snapshot(paths);
    const checkpoint = { id: `cp_${randomUUID().slice(0, 8)}`, label, tool, ts: new Date().toISOString(), paths, before, after };
    const list = await this.load(sessionId);
    list.push(checkpoint);
    this.redoStack.set(sessionId, []);
    await this.persist(sessionId);
    return { result, checkpoint };
  }

  async list(sessionId) {
    const list = await this.load(sessionId);
    return list.map((c) => ({ id: c.id, label: c.label, tool: c.tool, ts: c.ts, paths: c.paths.map(displayPath) }));
  }

  async apply(state) {
    for (const [p, snap] of Object.entries(state)) {
      await fs.remove(p);
      if (!snap.existed) continue;
      if (snap.kind === 'directory') {
        await fs.ensureDir(p);
        for (const entry of snap.entries || []) {
          const targetPath = path.join(p, entry.path);
          if (entry.kind === 'directory') await fs.ensureDir(targetPath);
          else if (entry.kind === 'symlink') {
            await fs.ensureDir(path.dirname(targetPath));
            await fs.symlink(entry.target, targetPath);
          } else if (entry.kind === 'file') {
            await fs.ensureDir(path.dirname(targetPath));
            await fs.writeFile(targetPath, Buffer.from(entry.content, 'base64'));
          }
        }
      } else if (snap.kind === 'symlink') {
        await fs.ensureDir(path.dirname(p));
        await fs.symlink(snap.target, p);
      } else {
        await fs.ensureDir(path.dirname(p));
        const content = snap.kind === 'file' ? Buffer.from(snap.content, 'base64') : snap.content;
        await fs.writeFile(p, content, 'utf8');
      }
    }
  }

  async undo(sessionId) {
    const list = await this.load(sessionId);
    if (!list.length) return null;
    const checkpoint = list[list.length - 1];
    await this.apply(checkpoint.before);
    this.redoStack.set(sessionId, [...(this.redoStack.get(sessionId) || []), checkpoint]);
    list.pop();
    await this.persist(sessionId);
    return checkpoint;
  }

  async redo(sessionId) {
    const stack = this.redoStack.get(sessionId) || [];
    if (!stack.length) return null;
    const checkpoint = stack[stack.length - 1];
    await this.apply(checkpoint.after);
    const list = await this.load(sessionId);
    list.push(checkpoint);
    this.redoStack.set(sessionId, stack.slice(0, -1));
    await this.persist(sessionId);
    return checkpoint;
  }

  // Revert the last `n` checkpoints (most recent first).
  async rewind(sessionId, n = 1) {
    const applied = [];
    for (let i = 0; i < n; i++) {
      const cp = await this.undo(sessionId);
      if (!cp) break;
      applied.push(cp);
    }
    return applied;
  }
}
