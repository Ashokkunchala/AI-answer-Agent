import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

// Discovers markdown "skills" from the project and user config directories.
//
// Layout supports project `.agent/.agents/.claude/.codex/skills`, user-level
// Agent/Codex/Claude skill roots, configured roots, and Codex plugin caches.
//
// A skill's body is injected into the model context on demand via the `skill`
// tool, while a short catalog is always included in the system prompt.
export class SkillLoader {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.enabled = opts.enabled !== false;
    this.extraDirs = Array.isArray(opts.dirs) ? opts.dirs : [];
    this.refreshDirs();
    this.cache = null;
  }

  refreshDirs() {
    const home = os.homedir();
    const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
    const projectDirs = ['.agent/skills', '.agents/skills', '.claude/skills', '.codex/skills']
      .map((dir) => path.join(this.cwd, dir));
    const userDirs = [
      path.join(home, '.agents', 'skills'),
      path.join(codexHome, 'skills'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.config', 'agent', 'skills'),
      path.join(codexHome, 'plugins', 'cache'),
    ];
    // Search project skills first, then explicit config paths and user skills.
    // Codex plugin caches are scanned only for nested `skills/` directories.
    this.dirs = [...new Set([...projectDirs, ...this.extraDirs.map((dir) => path.resolve(this.cwd, dir)), ...userDirs])];
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.refreshDirs();
    this.cache = null;
  }

  setExtraDirs(dirs = []) {
    this.extraDirs = Array.isArray(dirs) ? dirs.filter((dir) => typeof dir === 'string' && dir.trim()) : [];
    this.refreshDirs();
    this.cache = null;
  }

  async nestedSkillRoots(root, depth = 0, maxDepth = 5) {
    if (depth >= maxDepth) return [];
    let entries;
    try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
    const roots = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue;
      const child = path.join(root, entry.name);
      if (entry.name.toLowerCase() === 'skills') roots.push(child);
      else roots.push(...await this.nestedSkillRoots(child, depth + 1, maxDepth));
    }
    return roots;
  }

  parseFrontmatter(text) {
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
    return { meta, body };
  }

  async discover() {
    const found = new Map();
    for (const configuredDir of this.dirs) {
      const dirs = path.basename(configuredDir).toLowerCase() === 'cache'
        ? await this.nestedSkillRoots(configuredDir)
        : [configuredDir];
      for (const dir of dirs) {
        if (!(await fs.pathExists(dir))) continue;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (e) {
          console.debug?.(`Failed to read skills dir ${dir}: ${e.message}`);
          continue;
        }
        for (const entry of entries) {
          let file = null;
          let fallbackName = entry.name;
          if (entry.isDirectory()) {
            const candidate = path.join(dir, entry.name, 'SKILL.md');
            if (await fs.pathExists(candidate)) file = candidate;
          } else if (entry.name.toLowerCase().endsWith('.md')) {
            file = path.join(dir, entry.name);
            fallbackName = entry.name.replace(/\.md$/i, '');
          }
          if (!file) continue;
          try {
            const { meta, body } = this.parseFrontmatter(await fs.readFile(file, 'utf8'));
            const name = meta.name || fallbackName;
            if (found.has(name)) continue; // project dirs win (listed first)
            found.set(name, { name, description: meta.description || '', body: body.trim(), file, source: dir });
          } catch (e) {
            console.debug?.(`Failed to load skill from ${file}: ${e.message}`);
            /* skip unreadable skills */
          }
        }
      }
    }
    return found;
  }

  async list() {
    if (!this.cache) this.cache = await this.discover();
    return [...this.cache.values()].map(({ name, description, file }) => ({ name, description, file }));
  }

  async load(name) {
    if (!this.cache) this.cache = await this.discover();
    return this.cache.get(name) || null;
  }

  // Short catalog appended to the system prompt.
  async catalog() {
    if (!this.enabled) return '';
    const skills = await this.list();
    if (!skills.length) return '';
    const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`);
    return `\n\n# Available skills\nLoad a skill with the \`skill\` tool when a task matches.\n${lines.join('\n')}`;
  }
}
