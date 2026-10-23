import fs from 'fs-extra';
import path from 'node:path';
import { defineTool } from './define-tool.js';
import { resolvePath, displayPath } from './path-utils.js';
import { parseUnifiedDiff, applyHunks } from './patch.js';

const MAX_LINE = 2000;
const DIFF_MAX_LINES = 600;
const MAX_READ_BYTES = 10 * 1024 * 1024;
const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 1000;

function withLineNumbers(text, offset = 0) {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line, i) => {
      const truncated = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + '…' : line;
      return `${String(offset + i + 1).padStart(6, ' ')}| ${truncated}`;
    })
    .join('\n');
}

// Line-level diff (LCS) used to render colored +/- diffs for edits.
export function lineDiff(oldStr, newStr) {
  const a = String(oldStr).split('\n');
  const b = String(newStr).split('\n');
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i++] });
    } else {
      out.push({ type: 'add', text: b[j++] });
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

export class FileTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
  }

  resolve(p) {
    return resolvePath(this.cwd, p);
  }

  get tools() {
    const read = defineTool({
      name: 'read',
      category: 'file',
      description:
        'Read a file from the local filesystem. Returns file contents with line numbers. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          offset: { type: 'integer', description: '0-based line offset to start reading from' },
          limit: { type: 'integer', description: 'Maximum number of lines to read (default 2000)' },
          line_start: { type: 'integer', description: '1-based first line to read (overrides offset)' },
          line_end: { type: 'integer', description: '1-based last line to read (overrides limit)' },
        },
        required: ['path'],
      },
      execute: async ({ path: p, offset = 0, limit = 2000, line_start, line_end }) => {
        const start = Number.isInteger(line_start) ? Math.max(0, line_start - 1) : Math.max(0, offset);
        const requestedCount = Number.isInteger(line_end) ? Math.max(1, line_end - start) : limit;
        const count = Number.isFinite(requestedCount) ? Math.max(1, Math.min(10000, Math.trunc(requestedCount))) : 2000;
        const fp = this.resolve(p);
        if (!(await fs.pathExists(fp))) throw new Error(`File not found: ${fp}`);
        const stat = await fs.stat(fp);
        if (stat.isDirectory()) return { title: fp, output: `Path is a directory, not a file: ${fp}` };
        if (stat.size > MAX_READ_BYTES) throw new Error(`File exceeds the ${MAX_READ_BYTES / (1024 * 1024)} MiB read limit: ${fp}`);
        const buffer = await fs.readFile(fp);
        if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) throw new Error(`File appears to be binary: ${fp}`);
        const text = buffer.toString('utf8');
        const allLines = text.split(/\r?\n/);
        const slice = allLines.slice(start, start + count).join('\n');
        const header = `${fp} (${allLines.length} lines)`;
        return {
          title: fp,
          output: `${header}\n${withLineNumbers(slice, start)}`,
          metadata: { totalLines: allLines.length, offset: start, limit: count, truncated: allLines.length > start + count },
        };
      },
    });

    const write = defineTool({
      name: 'write',
      category: 'file',
      description:
        'Write content to a file, creating parent directories as needed. Overwrites the file if it exists.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Full file contents' },
        },
        required: ['path', 'content'],
      },
      execute: async ({ path: p, content = '' }) => {
        const fp = this.resolve(p);
        await fs.ensureDir(path.dirname(fp));
        let prev = null;
        if (await fs.pathExists(fp)) {
          try {
            prev = await fs.readFile(fp, 'utf8');
          } catch {
            prev = null;
          }
        }
        await fs.writeFile(fp, content, 'utf8');
        const metadata = { bytes: Buffer.byteLength(content), file: fp, touched: [fp] };
        if (prev !== null && prev.split('\n').length < DIFF_MAX_LINES && content.split('\n').length < DIFF_MAX_LINES) {
          metadata.diff = lineDiff(prev, content);
        }
        return { title: displayPath(fp), output: `Wrote ${metadata.bytes} bytes to ${displayPath(fp)}`, metadata };
      },
    });

    const edit = defineTool({
      name: 'edit',
      category: 'file',
      description:
        'Replace an exact string in a file. oldString must match exactly (including whitespace). Fails if the string is missing or ambiguous unless replaceAll is true.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File to edit' },
          oldString: { type: 'string', description: 'Exact text to replace' },
          newString: { type: 'string', description: 'Replacement text' },
          replaceAll: { type: 'boolean', description: 'Replace all occurrences (default false)' },
        },
        required: ['path', 'oldString', 'newString'],
      },
      execute: async ({ path: p, oldString, newString, replaceAll = false }) => {
        const fp = this.resolve(p);
        if (!(await fs.pathExists(fp))) throw new Error(`File not found: ${fp}`);
        const text = await fs.readFile(fp, 'utf8');
        if (!oldString) throw new Error('oldString must not be empty');
        if (oldString === newString) throw new Error('oldString and newString are identical');
        const count = text.split(oldString).length - 1;
        if (count === 0) throw new Error('oldString not found in file');
        if (count > 1 && !replaceAll) throw new Error(`oldString matched ${count} times; provide more context or set replaceAll=true`);
        const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
        await fs.writeFile(fp, updated, 'utf8');
        return {
          title: displayPath(fp),
          output: `Replaced ${replaceAll ? count : 1} occurrence(s) in ${displayPath(fp)}`,
          metadata: { occurrences: replaceAll ? count : 1, file: fp, touched: [fp], diff: lineDiff(text, updated) },
        };
      },
    });

    const patch = defineTool({
      name: 'patch',
      category: 'file',
      description:
        'Apply multiple edits atomically. Provide `edits` (array of {path, oldString, newString, replaceAll}) or a unified `diff`. If any edit fails, nothing is written.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'List of string-replacement edits applied atomically',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                oldString: { type: 'string' },
                newString: { type: 'string' },
                replaceAll: { type: 'boolean' },
              },
              required: ['path', 'oldString', 'newString'],
            },
          },
          diff: { type: 'string', description: 'A unified diff (git/diff -u format) to apply instead of edits' },
        },
      },
      execute: async ({ edits, diff }) => this.applyPatch({ edits, diff }),
    });

    const list = defineTool({
      name: 'list',
      category: 'file',
      description: 'List files and directories at a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default workspace root)' },
          limit: { type: 'integer', description: `Maximum entries to return (default ${DEFAULT_LIST_LIMIT}, maximum ${MAX_LIST_LIMIT})` },
        },
      },
      execute: async ({ path: p = '.', limit = DEFAULT_LIST_LIMIT }) => {
        const fp = this.resolve(p);
        const entries = await fs.readdir(fp, { withFileTypes: true });
        const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(limit))) : DEFAULT_LIST_LIMIT;
        const formatted = entries.slice(0, boundedLimit)
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        const truncated = entries.length > boundedLimit;
        return {
          title: fp,
          output: `${fp}\n${formatted.join('\n')}${truncated ? `\n... ${entries.length - boundedLimit} more entries omitted` : ''}`,
          metadata: { count: entries.length, returned: formatted.length, truncated },
        };
      },
    });

    const mkdir = defineTool({
      name: 'mkdir',
      category: 'file',
      description: 'Create a directory (and parents).',
      mutating: true,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory to create' } },
        required: ['path'],
      },
      execute: async ({ path: p }) => {
        const fp = this.resolve(p);
        await fs.ensureDir(fp);
        return { title: displayPath(fp), output: `Created directory ${displayPath(fp)}`, metadata: { file: fp, touched: [fp] } };
      },
    });

    const move = defineTool({
      name: 'move',
      category: 'file',
      description: 'Move or rename a file or directory.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path' },
          to: { type: 'string', description: 'Destination path' },
          overwrite: { type: 'boolean', description: 'Overwrite destination if it exists (default false)' },
        },
        required: ['from', 'to'],
      },
      execute: async ({ from, to, overwrite = false }) => {
        const src = this.resolve(from);
        const dest = this.resolve(to);
        if (!(await fs.pathExists(src))) throw new Error(`Source not found: ${src}`);
        if ((await fs.pathExists(dest)) && !overwrite) throw new Error(`Destination exists: ${dest} (set overwrite=true)`);
        await fs.ensureDir(path.dirname(dest));
        await fs.move(src, dest, { overwrite });
        return { title: `${displayPath(src)} → ${displayPath(dest)}`, output: `Moved ${displayPath(src)} to ${displayPath(dest)}`, metadata: { file: dest, touched: [src, dest] } };
      },
    });

    const remove = defineTool({
      name: 'delete',
      category: 'file',
      description: 'Delete a file or directory (recursively). Use with care.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to delete' },
          recursive: { type: 'boolean', description: 'Allow deleting a non-empty directory (default false)' },
        },
        required: ['path'],
      },
      execute: async ({ path: p, recursive = false }) => {
        const fp = this.resolve(p);
        if (!(await fs.pathExists(fp))) throw new Error(`Path not found: ${fp}`);
        const stat = await fs.stat(fp);
        if (stat.isDirectory() && !recursive) {
          const entries = await fs.readdir(fp);
          if (entries.length) throw new Error(`Directory not empty: ${fp} (set recursive=true)`);
        }
        await fs.remove(fp);
        return { title: displayPath(fp), output: `Deleted ${displayPath(fp)}`, metadata: { file: fp, touched: [fp] } };
      },
    });

    return { read, write, edit, patch, list, mkdir, move, delete: remove };
  }

  async applyPatch({ edits, diff }) {
    const touched = [];
    const diffs = [];
    if (Array.isArray(edits) && edits.length) {
      // Validate all edits first so the operation is atomic.
      const stagedByPath = new Map();
      for (const edit of edits) {
        const fp = this.resolve(edit.path);
        const key = process.platform === 'win32' ? fp.toLowerCase() : fp;
        let staged = stagedByPath.get(key);
        if (!staged) {
          const existed = await fs.pathExists(fp);
          const original = existed ? await fs.readFile(fp, 'utf8') : '';
          staged = { fp, existed, original, updated: original };
          stagedByPath.set(key, staged);
        }
        if (typeof edit.oldString !== 'string' || !edit.oldString) throw new Error(`oldString must not be empty for ${displayPath(fp)}`);
        if (typeof edit.newString !== 'string') throw new Error(`newString must be a string for ${displayPath(fp)}`);
        if (edit.oldString === edit.newString) throw new Error(`No-op edit for ${displayPath(fp)}`);
        const count = staged.updated.split(edit.oldString).length - 1;
        if (count === 0) throw new Error(`oldString not found in ${displayPath(fp)}: ${JSON.stringify(edit.oldString.slice(0, 40))}`);
        if (count > 1 && !edit.replaceAll) throw new Error(`oldString matched ${count} times in ${displayPath(fp)}; add more context or set replaceAll=true`);
        staged.updated = edit.replaceAll
          ? staged.updated.split(edit.oldString).join(edit.newString)
          : staged.updated.replace(edit.oldString, edit.newString);
      }
      await this.commitStaged([...stagedByPath.values()], touched, diffs);
    } else if (diff) {
      const parsed = parseUnifiedDiff(diff);
      if (!parsed.length) throw new Error('No applicable hunks found in diff');
      const stagedByPath = new Map();
      for (const file of parsed) {
        const fp = this.resolve(file.path);
        const key = process.platform === 'win32' ? fp.toLowerCase() : fp;
        let staged = stagedByPath.get(key);
        if (!staged) {
          const existed = await fs.pathExists(fp);
          const original = existed ? await fs.readFile(fp, 'utf8') : '';
          staged = { fp, existed, original, updated: original };
          stagedByPath.set(key, staged);
        }
        staged.updated = applyHunks(staged.updated, file.hunks);
      }
      await this.commitStaged([...stagedByPath.values()], touched, diffs);
    } else {
      throw new Error('Provide either `edits` or `diff`');
    }
    const output = [`Patched ${touched.length} file(s):`, ...touched.map((f) => `- ${displayPath(f)}`)].join('\n');
    return { title: `patch (${touched.length})`, output, metadata: { touched, diffs, files: diffs.map((d) => d.path) } };
  }

  async commitStaged(staged, touched, diffs) {
    const written = [];
    try {
      for (const item of staged) {
        await fs.ensureDir(path.dirname(item.fp));
        written.push(item);
        await fs.writeFile(item.fp, item.updated, 'utf8');
        touched.push(item.fp);
        diffs.push({ path: item.fp, diff: lineDiff(item.original, item.updated) });
      }
    } catch (error) {
      for (const item of written.reverse()) {
        try {
          if (item.existed) await fs.writeFile(item.fp, item.original, 'utf8');
          else await fs.remove(item.fp);
        } catch {
          // Preserve the original write error if rollback also fails.
        }
      }
      throw error;
    }
  }
}
