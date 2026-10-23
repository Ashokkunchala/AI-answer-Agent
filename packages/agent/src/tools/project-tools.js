import fs from 'fs-extra';
import path from 'node:path';
import { glob } from 'glob';
import { defineTool } from './define-tool.js';

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/.wrangler/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/.agent/**', '**/.env*'];
const KEY_FILES = ['README.md', 'package.json', 'pnpm-workspace.yaml', 'yarn.lock', 'package-lock.json', 'tsconfig.json', 'wrangler.toml', 'Dockerfile', 'docker-compose.yml'];

function concisePath(file) {
  return file.split(path.sep).join('/');
}

// Produces a bounded, useful repository inventory. This is intentionally a
// first-class tool: asking a model to repeatedly call `list` cannot reliably
// produce a complete project overview on a large repository.
export class ProjectTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
  }

  get tools() {
    const projectmap = defineTool({
      name: 'projectmap',
      category: 'search',
      description: 'Build a compact inventory of the current repository: source layout, file counts by extension, and key project files. Use this before explaining a whole project or repository.',
      parameters: {
        type: 'object',
        properties: {
          depth: { type: 'integer', description: 'Maximum directory depth to show (default 3)' },
          maxFiles: { type: 'integer', description: 'Maximum files included in the inventory (default 1000)' },
        },
      },
      execute: async ({ depth = 3, maxFiles = 1000 } = {}) => this.buildMap(depth, maxFiles),
    });
    return { projectmap };
  }

  async buildMap(depth, maxFiles) {
    const files = await glob('**/*', {
      cwd: this.cwd,
      nodir: true,
      // Include useful project metadata such as .github, while excluding
      // credential-bearing configuration above.
      dot: true,
      ignore: IGNORE,
      follow: false,
    });
    const capped = files.slice(0, Math.max(1, Math.min(maxFiles, 5000)));
    const extensionCounts = new Map();
    const topLevel = new Map();
    for (const file of capped) {
      const ext = path.extname(file).toLowerCase() || '[no extension]';
      extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
      const parts = concisePath(file).split('/');
      const key = parts.slice(0, Math.min(parts.length, Math.max(1, depth))).join('/');
      topLevel.set(key, (topLevel.get(key) || 0) + 1);
    }

    const presentKeyFiles = [];
    for (const name of KEY_FILES) {
      if (await fs.pathExists(path.join(this.cwd, name))) presentKeyFiles.push(name);
    }
    const lines = [
      `Repository: ${this.cwd}`,
      `Files: ${files.length}${files.length > capped.length ? ` (first ${capped.length} mapped)` : ''}`,
      `Key files: ${presentKeyFiles.join(', ') || '(none found)'}`,
      '',
      'Layout:',
      ...[...topLevel.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(0, 250).map(([name, count]) => `- ${name}${count > 1 ? ` (${count} files)` : ''}`),
      '',
      'File types:',
      ...[...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([ext, count]) => `- ${ext}: ${count}`),
    ];
    return {
      title: 'project map',
      output: lines.join('\n'),
      metadata: { files: files.length, mappedFiles: capped.length, keyFiles: presentKeyFiles },
    };
  }
}
