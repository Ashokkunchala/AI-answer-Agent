import { glob as globFn } from 'glob';
import fs from 'fs-extra';
import path from 'node:path';
import { defineTool } from './define-tool.js';

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];
const MAX_RESULTS = 200;

export class SearchTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
  }

  resolve(p) {
    if (!p) return this.cwd;
    return path.isAbsolute(p) ? p : path.resolve(this.cwd, p);
  }

  get tools() {
    const glob = defineTool({
      name: 'glob',
      description: 'Find files by glob pattern (e.g. "src/**/*.js"). Sorted by most recently modified.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Directory to search (default workspace root)' },
        },
        required: ['pattern'],
      },
      execute: async ({ pattern, path: p = '.' }) => {
        const cwd = this.resolve(p);
        const matches = await globFn(pattern, { cwd, nodir: true, ignore: DEFAULT_IGNORE });
        const withStats = await Promise.all(
          matches.slice(0, MAX_RESULTS).map(async (file) => {
            try {
              return { file, mtime: (await fs.stat(path.join(cwd, file))).mtimeMs };
            } catch {
              return { file, mtime: 0 };
            }
          })
        );
        withStats.sort((a, b) => b.mtime - a.mtime);
        const output = withStats.map((m) => path.join(cwd, m.file)).join('\n') || '(no matches)';
        return { title: pattern, output, metadata: { count: matches.length } };
      },
    });

    const grep = defineTool({
      name: 'grep',
      description: 'Search file contents with a regular expression. Returns matching lines with file:line locations.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression' },
          path: { type: 'string', description: 'Directory to search (default workspace root)' },
          include: { type: 'string', description: 'Glob filter for files (e.g. "**/*.js")' },
        },
        required: ['pattern'],
      },
      execute: async ({ pattern, path: p = '.', include }) => {
        const cwd = this.resolve(p);
        let re;
        try {
          re = new RegExp(pattern, 'i');
        } catch (e) {
          throw new Error(`Invalid regex: ${e.message}`);
        }
        const files = await globFn(include || '**/*', { cwd, nodir: true, ignore: DEFAULT_IGNORE });
        const matches = [];
        for (const file of files) {
          if (matches.length >= MAX_RESULTS) break;
          let text;
          try {
            text = await fs.readFile(path.join(cwd, file), 'utf8');
          } catch {
            continue;
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matches.length < MAX_RESULTS; i++) {
            if (re.test(lines[i])) matches.push(`${file}:${i + 1}: ${lines[i].slice(0, 300)}`);
          }
        }
        const output = matches.join('\n') || '(no matches)';
        return { title: pattern, output, metadata: { count: matches.length } };
      },
    });

    return { glob, grep };
  }
}
