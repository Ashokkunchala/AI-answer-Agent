import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

// User-defined slash commands loaded from markdown files.
//
//   <cwd>/.agent/commands/<name>.md
//   ~/.config/agent/commands/<name>.md
//
// The file body is a prompt template. `$ARGUMENTS` is replaced with the text
// after the command, and `$1`..`$9` with individual arguments.
export class CustomCommands {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.enabled = opts.enabled !== false;
    this.dirs = [path.join(this.cwd, '.agent', 'commands'), path.join(os.homedir(), '.config', 'agent', 'commands')];
    this.cache = null;
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.dirs = [path.join(cwd, '.agent', 'commands'), path.join(os.homedir(), '.config', 'agent', 'commands')];
    this.cache = null;
  }

  parse(text) {
    const meta = {};
    let body = text;
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (match) {
      body = text.slice(match[0].length);
      for (const line of match[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (kv) meta[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    }
    return { meta, body: body.trim() };
  }

  async discover() {
    const found = new Map();
    for (const dir of this.dirs) {
      if (!(await fs.pathExists(dir))) continue;
      let files;
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.md')) continue;
        const name = file.replace(/\.md$/i, '');
        if (found.has(name)) continue;
        try {
          const { meta, body } = this.parse(await fs.readFile(path.join(dir, file), 'utf8'));
          found.set(name, { name: meta.name || name, description: meta.description || '', body, file: path.join(dir, file) });
        } catch {
          /* skip */
        }
      }
    }
    return found;
  }

  async list() {
    if (!this.enabled) return [];
    if (!this.cache) this.cache = await this.discover();
    return [...this.cache.values()].map(({ name, description, file }) => ({ name, description, file }));
  }

  async expand(name, args = '') {
    if (!this.cache) this.cache = await this.discover();
    const command = this.cache.get(name);
    if (!command) return null;
    const parts = String(args).split(/\s+/);
    const body = command.body
      .replace(/\$ARGUMENTS/g, args)
      .replace(/\$(\d)/g, (_, n) => parts[Number(n) - 1] || '');
    return { name: command.name, prompt: body };
  }
}
