import { glob as globFn } from 'glob';
import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { defineTool } from './define-tool.js';
import { resolvePath } from './path-utils.js';

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.wrangler/**'];
const DEFAULT_MAX = 200;
const MAX_LINE = 300;

function hasRipgrep() {
  try {
    return spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

export class SearchTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.backend = opts.searchBackend || 'auto';
    this._rg = null;
  }

  resolve(p) {
    return resolvePath(this.cwd, p);
  }

  rg() {
    if (this._rg === null) this._rg = this.backend === 'native' ? false : hasRipgrep();
    return this._rg;
  }

  get tools() {
    const glob = defineTool({
      name: 'glob',
      category: 'search',
      description: 'Find files by glob pattern (e.g. "src/**/*.js"). Sorted by most recently modified.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Directory to search (default workspace root)' },
          maxResults: { type: 'integer', description: 'Maximum number of files to return (default 200)' },
        },
        required: ['pattern'],
      },
      execute: async ({ pattern, path: p = '.', maxResults = DEFAULT_MAX }) => {
        const cwd = this.resolve(p);
        const matches = await globFn(pattern, { cwd, nodir: true, dot: true, ignore: DEFAULT_IGNORE, follow: false });
        const withStats = await Promise.all(
          matches.slice(0, maxResults).map(async (file) => {
            try {
              return { file, mtime: (await fs.stat(path.join(cwd, file))).mtimeMs };
            } catch {
              return { file, mtime: 0 };
            }
          })
        );
        withStats.sort((a, b) => b.mtime - a.mtime);
        const output = withStats.map((m) => path.join(cwd, m.file)).join('\n') || '(no matches)';
        return { title: pattern, output, metadata: { count: matches.length, returned: withStats.length } };
      },
    });

    const grep = defineTool({
      name: 'grep',
      category: 'search',
      description:
        'Search file contents with a regular expression (or fixed string). Returns matching lines as file:line:text. Uses ripgrep when available.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression (or literal text when fixedStrings=true)' },
          path: { type: 'string', description: 'Directory to search (default workspace root)' },
          include: { type: 'string', description: 'Glob filter for files (e.g. "**/*.js")' },
          caseSensitive: { type: 'boolean', description: 'Match case-sensitively (default false)' },
          fixedStrings: { type: 'boolean', description: 'Treat the pattern as a literal string (default false)' },
          contextLines: { type: 'integer', description: 'Lines of context around each match (default 0)' },
          filesWithMatches: { type: 'boolean', description: 'Only list file paths that contain a match' },
          maxResults: { type: 'integer', description: 'Maximum number of matches (default 200)' },
        },
        required: ['pattern'],
      },
      execute: async (args) => (this.rg() ? this.grepRg(args) : this.grepNative(args)),
    });

    return { glob, grep };
  }

  grepRg({ pattern, path: p = '.', include, caseSensitive, fixedStrings, contextLines = 0, filesWithMatches, maxResults = DEFAULT_MAX }) {
    const cwd = this.resolve(p);
    const cliArgs = ['--no-heading', '--line-number', '--color', 'never'];
    if (!caseSensitive) cliArgs.push('-i');
    if (fixedStrings) cliArgs.push('-F');
    if (contextLines > 0) cliArgs.push('-C', String(contextLines));
    if (filesWithMatches) cliArgs.push('-l');
    if (include) cliArgs.push('--glob', include);
    for (const ig of DEFAULT_IGNORE) cliArgs.push('--glob', `!${ig}`);
    cliArgs.push(pattern, '.');
    const res = spawnSync('rg', cliArgs, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (res.error) throw res.error;
    const lines = (res.stdout || '').split('\n').filter(Boolean).slice(0, maxResults);
    const output = lines.map((line) => line.replace(/^\.\//, '').slice(0, MAX_LINE + 80)).join('\n') || '(no matches)';
    return { title: pattern, output, metadata: { count: lines.length, backend: 'rg' } };
  }

  async grepNative({ pattern, path: p = '.', include, caseSensitive, fixedStrings, contextLines = 0, filesWithMatches, maxResults = DEFAULT_MAX }) {
    const cwd = this.resolve(p);
    let test;
    if (fixedStrings) {
      const needle = caseSensitive ? pattern : pattern.toLowerCase();
      test = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
    } else {
      let re;
      try {
        re = new RegExp(pattern, caseSensitive ? '' : 'i');
      } catch (e) {
        throw new Error(`Invalid regex: ${e.message}`);
      }
      test = (line) => re.test(line);
    }
    const files = await globFn(include || '**/*', { cwd, nodir: true, dot: true, ignore: DEFAULT_IGNORE, follow: false });
    const matches = [];
    const fileSet = new Set();
    for (const file of files) {
      if (matches.length >= maxResults) break;
      let text;
      try {
        text = await fs.readFile(path.join(cwd, file), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!test(lines[i])) continue;
        fileSet.add(file);
        if (filesWithMatches) break;
        if (contextLines > 0) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length - 1, i + contextLines);
          for (let k = start; k <= end; k++) {
            const marker = k === i ? ':' : '-';
            matches.push(`${file}${marker}${k + 1}${marker}${lines[k].slice(0, MAX_LINE)}`);
            if (matches.length >= maxResults) break;
          }
        } else {
          matches.push(`${file}:${i + 1}: ${lines[i].slice(0, MAX_LINE)}`);
        }
        if (matches.length >= maxResults) break;
      }
    }
    const list = filesWithMatches ? [...fileSet] : matches;
    const output = list.join('\n') || '(no matches)';
    return { title: pattern, output, metadata: { count: list.length, backend: 'native' } };
  }
}
