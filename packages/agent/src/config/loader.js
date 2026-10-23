import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// Config schema. Extra keys are preserved (passthrough) so `config --set`
// can store arbitrary user preferences without being silently dropped.
export const ConfigSchema = z
  .object({
    provider: z.enum(['worker', 'gemini']).default('worker'),
    workerUrl: z.string().default('https://devops-ai-agent.ashokkunchla.workers.dev'),
    geminiUrl: z.string().default('https://generativelanguage.googleapis.com/v1beta/openai'),
    apiKey: z.string().optional(),
    // Guard against placeholder text leaking into the config (e.g. a
    // `agent config --set model=[name]` copy/paste from the docs) — such a
    // value makes every request fail with `Unknown model`. Fall back to the
    // router's free-tier-first `auto` pick instead of hard-failing the turn.
    model: z
      .string()
      .default('auto')
      .transform((value) => {
        const trimmed = String(value || '').trim();
        const placeholder = /^\[.*\]$/.test(trimmed) || /^\$\{.*\}$/.test(trimmed) || /^<.*>$/.test(trimmed) || /\s/.test(trimmed);
        return !trimmed || placeholder ? 'auto' : trimmed;
      }),
    systemPrompt: z.string().optional(),

    // Agentic behaviour (opencode-style abilities).
    tools: z.boolean().default(true),
    streaming: z.boolean().default(true),
    // Stream tool-call deltas when the Worker supports it (gateway). Falls
    // back to buffered calls automatically.
    toolStream: z.boolean().default(true),
    // Legacy single switch. When set, it overrides permissionMode.
    autoApprove: z.boolean().optional(),
    // allow = run everything; ask = prompt for mutating tools; deny = block.
    permissionMode: z.enum(['allow', 'ask', 'deny']).default('allow'),
    // Tool allow/deny lists (names). Deny wins over allow.
    allowedTools: z.array(z.string()).default([]),
    deniedTools: z.array(z.string()).default([]),
    // Extra path roots the agent may write to (defaults to cwd).
    allowedPaths: z.array(z.string()).default([]),
    deniedPaths: z.array(z.string()).default([]),
    // Show a unified diff before approving a mutating tool.
    diffPreview: z.boolean().default(true),
    // Snapshot files before edits so /undo and /rewind work.
    checkpoints: z.boolean().default(true),
    // After edits, run the project's typecheck/lint/test script if one exists.
    autoCheck: z.boolean().default(true),
    // Long-running implementation and review tasks frequently need more than
    // a handful of tool round trips. The terminal UI still exposes cancel.
    maxSteps: z.number().int().positive().max(200).default(60),
    temperature: z.number().min(0).max(2).default(0.2),
    // Compress old history with a summary when it grows past this many turns.
    summarize: z.boolean().default(true),
    maxHistory: z.number().int().positive().max(1000).default(80),

    // Capabilities.
    subagents: z.boolean().default(true),
    skills: z.boolean().default(true),
    skillDirs: z.array(z.string()).default([]),
    customCommands: z.boolean().default(true),

    // Tool behaviour.
    shell: z.string().optional(),
    searchBackend: z.enum(['auto', 'rg', 'native']).default('auto'),

    // Workspace / UI.
    cwd: z.string().optional(),
    sessionsDir: z.string().optional(),
    checkpointsDir: z.string().optional(),
    theme: z.string().default('auto'),
    autoSave: z.boolean().default(true),
  })
  .passthrough();

export function redactConfig(config = {}) {
  const secretName = /(?:api[-_]?key|token|secret|password|credential|private[-_]?key)/i;
  const redact = (value) => {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretName.test(key) ? (item ? '[configured]' : item) : redact(item)]));
  };
  return redact(config);
}

export class ConfigLoader {
  constructor(opts = {}) {
    this.opts = opts;
    this.cwd = opts.cwd || process.cwd();
    this.binDir = opts.binDir;
    this._loadedConfig = null;
    this._configSource = null;
  }

  /**
   * Get the loaded config without re-reading from disk.
   * Useful for callers that need the config immediately after load().
   */
  get loadedConfig() {
    return this._loadedConfig;
  }

  get configSource() {
    return this._configSource;
  }

  getConfigPaths() {
    const home = os.homedir();
    const paths = [];

    // 1. Project-local (highest priority).
    paths.push(path.join(this.cwd, '.agent', 'config.json'));
    paths.push(path.join(this.cwd, '.workercli', 'config.json'));

    // 2. Agent Terminal's own user-global config, followed by workercli
    //    compatibility paths so existing installs keep working.
    paths.push(path.join(home, '.config', 'agent-terminal', 'config.json'));
    paths.push(path.join(home, '.agent-terminal', 'config.json'));
    paths.push(path.join(home, '.config', 'workercli', 'config.json'));
    paths.push(path.join(home, '.workercli', 'config.json'));
    paths.push(path.join(home, '.config', 'devops-agent', 'config.json'));
    paths.push(path.join(home, '.devops-agent', 'config.json'));

    // 3. Shipped default next to the CLI package (lowest priority).
    if (this.binDir) {
      const pkgRoot = path.resolve(this.binDir, '..');
      paths.push(path.join(pkgRoot, '.agent', 'config.json'));
    }

    // De-dupe while preserving order.
    return [...new Set(paths)];
  }

  // Canonical user-global config path used by `agent setup --global`.
  globalConfigPath() {
    return path.join(os.homedir(), '.config', 'agent-terminal', 'config.json');
  }

  async loadGlobalApiKey() {
    try {
      const config = await fs.readJson(this.globalConfigPath());
      return typeof config.apiKey === 'string' ? config.apiKey : '';
    } catch {
      return '';
    }
  }

  async saveGlobalApiKey(apiKey) {
    const target = this.globalConfigPath();
    let config = {};
    try { config = await fs.readJson(target); } catch { /* create config on first run */ }
    config.apiKey = apiKey;
    await this.save(config, target);
    return target;
  }

  async load() {
    for (const p of this.getConfigPaths()) {
      if (await fs.pathExists(p)) {
        try {
          const raw = await fs.readJson(p);
          const parsed = ConfigSchema.safeParse(raw);
          if (parsed.success) {
            this._loadedConfig = parsed.data;
            this._configSource = p;
            return { config: parsed.data, source: p };
          }
        } catch (e) {
          // Ignore malformed config and fall through to the next candidate.
          console.debug?.(`Failed to load config from ${p}: ${e.message}`);
        }
      }
    }
    const defaults = ConfigSchema.parse({});
    this._loadedConfig = defaults;
    this._configSource = null;
    return { config: defaults, source: null };
  }

  /**
   * Reload config from disk, clearing the cache.
   * Useful after external changes to config files.
   */
  async reload() {
    this._loadedConfig = null;
    this._configSource = null;
    return this.load();
  }

  async save(config, targetPath) {
    const parsed = ConfigSchema.parse(config);
    const p = targetPath || path.join(this.cwd, '.agent', 'config.json');
    await fs.ensureDir(path.dirname(p));
    await fs.writeJson(p, parsed, { spaces: 2 });
    // Update cached config if saving to the currently loaded source
    if (!targetPath || targetPath === this._configSource) {
      this._loadedConfig = parsed;
    }
    return p;
  }
}
