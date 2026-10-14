import fs from 'fs-extra';
import path from 'node:path';
import { defineTool } from './define-tool.js';

const MAX_LINE = 2000;

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
    if (!p) return this.cwd;
    return path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
  }

  get tools() {
    const read = defineTool({
      name: 'read',
      description:
        'Read a file from the local filesystem. Returns file contents with line numbers. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or workspace-relative file path' },
          offset: { type: 'integer', description: '0-based line offset to start reading from' },
          limit: { type: 'integer', description: 'Maximum number of lines to read (default 2000)' },
        },
        required: ['path'],
      },
      execute: async ({ path: p, offset = 0, limit = 2000, line_start, line_end }) => {
        const start = Number.isInteger(line_start) ? Math.max(0, line_start - 1) : offset;
        const count = Number.isInteger(line_end) ? Math.max(1, line_end - start) : limit;
        const fp = this.resolve(p);
        if (!(await fs.pathExists(fp))) throw new Error(`File not found: ${fp}`);
        const stat = await fs.stat(fp);
        if (stat.isDirectory()) return { title: fp, output: `Path is a directory, not a file: ${fp}` };
        const text = await fs.readFile(fp, 'utf8');
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
        const metadata = { bytes: Buffer.byteLength(content), file: fp };
        if (prev !== null && prev.split('\n').length < 400 && content.split('\n').length < 400) {
          metadata.diff = lineDiff(prev, content);
        }
        return { title: fp, output: `Wrote ${metadata.bytes} bytes to ${fp}`, metadata };
      },
    });

    const edit = defineTool({
      name: 'edit',
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
        if (oldString === newString) throw new Error('oldString and newString are identical');
        const count = text.split(oldString).length - 1;
        if (count === 0) throw new Error('oldString not found in file');
        if (count > 1 && !replaceAll) throw new Error(`oldString matched ${count} times; provide more context or set replaceAll=true`);
        const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
        await fs.writeFile(fp, updated, 'utf8');
        return {
          title: fp,
          output: `Replaced ${replaceAll ? count : 1} occurrence(s) in ${fp}`,
          metadata: { occurrences: replaceAll ? count : 1, file: fp, diff: lineDiff(oldString, newString) },
        };
      },
    });

    const list = defineTool({
      name: 'list',
      description: 'List files and directories at a path.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default workspace root)' } },
      },
      execute: async ({ path: p = '.' }) => {
        const fp = this.resolve(p);
        const entries = await fs.readdir(fp, { withFileTypes: true });
        const formatted = entries
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { title: fp, output: `${fp}\n${formatted.join('\n')}`, metadata: { count: entries.length } };
      },
    });

    return { read, write, edit, list };
  }
}
