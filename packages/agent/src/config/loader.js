import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Config schema. Extra keys are preserved (passthrough) so `config --set`
// can store arbitrary user preferences without being silently dropped.
export const ConfigSchema = z
  .object({
    // Where the agent sends requests. Defaults to the local wrangler dev server.
    workerUrl: z.string().default('http://127.0.0.1:8787'),
    autoStartWorker: z.boolean().default(true),
    apiKey: z.string().optional(),
    model: z.string().default('auto'),
    systemPrompt: z.string().optional(),

    // Agentic behaviour (opencode-style abilities).
    tools: z.boolean().default(true),
    streaming: z.boolean().default(true),
    // When false, mutating tools (write/edit/bash) ask before running.
    autoApprove: z.boolean().default(false),
    // After edits, run the project's typecheck/lint/test script if one exists.
    autoCheck: z.boolean().default(true),
    // Long-running implementation and review tasks frequently need more than
    // a handful of tool round trips. The terminal UI still exposes cancel.
    maxSteps: z.number().int().positive().max(200).default(60),
    temperature: z.number().min(0).max(2).default(0.2),

    // Workspace / UI.
    cwd: z.string().optional(),
    sessionsDir: z.string().optional(),
    theme: z.string().default('auto'),
    autoSave: z.boolean().default(true),
  })
  .passthrough();

export class ConfigLoader {
  constructor(opts = {}) {
    this.opts = opts;
    this.cwd = opts.cwd || process.cwd();
    this.binDir = opts.binDir;
  }

  getConfigPaths() {
    const home = os.homedir();
    const paths = [];

    // 1. Project-local (highest priority).
    paths.push(path.join(this.cwd, '.agent', 'config.json'));
    paths.push(path.join(this.cwd, '.workercli', 'config.json'));

    // 2. Shipped default next to the CLI package.
    if (this.binDir) {
      const pkgRoot = path.resolve(this.binDir, '..');
      paths.push(path.join(pkgRoot, '.agent', 'config.json'));
    }

    // 3. User-global.
    paths.push(path.join(home, '.config', 'workercli', 'config.json'));
    paths.push(path.join(home, '.workercli', 'config.json'));
    paths.push(path.join(home, '.config', 'devops-agent', 'config.json'));
    paths.push(path.join(home, '.devops-agent', 'config.json'));

    // De-dupe while preserving order.
    return [...new Set(paths)];
  }

  async load() {
    for (const p of this.getConfigPaths()) {
      if (await fs.pathExists(p)) {
        try {
          const raw = await fs.readJson(p);
          const parsed = ConfigSchema.safeParse(raw);
          if (parsed.success) return { config: parsed.data, source: p };
        } catch {
          // Ignore malformed config and fall through to the next candidate.
        }
      }
    }
    return { config: ConfigSchema.parse({}), source: null };
  }

  async save(config, targetPath) {
    const parsed = ConfigSchema.parse(config);
    const p = targetPath || path.join(this.cwd, '.agent', 'config.json');
    await fs.ensureDir(path.dirname(p));
    await fs.writeJson(p, parsed, { spaces: 2 });
    return p;
  }
}
