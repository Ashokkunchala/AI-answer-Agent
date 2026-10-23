import fs from 'fs-extra';
import path from 'node:path';
import { isWithin, resolvePath } from '../tools/path-utils.js';
import { parseUnifiedDiff } from '../tools/patch.js';

const SENSITIVE_DIRECTORIES = new Set(['.ssh', '.aws', '.azure', '.gcloud', '.gnupg']);
const SENSITIVE_FILES = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa',
  'credentials', 'credentials.json', 'kubeconfig',
]);
const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);

function isSensitivePath(value) {
  const parts = String(value).toLowerCase().split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) || '';
  if (parts.some((part) => SENSITIVE_DIRECTORIES.has(part))) return true;
  if (name === 'config.json' && parts.some((part) => ['.agent', '.workercli', '.agent-terminal'].includes(part))) return true;
  if (SENSITIVE_FILES.has(name) || (name.startsWith('.env') && !SAFE_ENV_EXAMPLES.has(name))) return true;
  return ['.pem', '.key', '.p12', '.pfx', '.keystore'].includes(path.extname(name));
}

// Decides whether a tool call needs explicit user approval before it runs.
//
// Resolution order (highest priority first):
//   1. persistent rule for the tool (`.agent/permissions.json`)
//   2. config.deniedTools / config.allowedTools
//   3. a path outside the workspace (always requires approval unless allowed)
//   4. permissionMode (allow | ask | deny); autoApprove overrides it when set
export class PermissionManager {
  constructor(config = {}, opts = {}) {
    this.config = config || {};
    this.cwd = opts.cwd || process.cwd();
    this.permissionsFile = path.join(this.cwd, '.agent', 'permissions.json');
    this.rules = { tools: {}, paths: {} };
    this.sessionAlways = new Set();
    this._loaded = false;
  }

  setConfig(config) {
    this.config = config || {};
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.permissionsFile = path.join(cwd, '.agent', 'permissions.json');
    this.rules = { tools: {}, paths: {} };
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (await fs.pathExists(this.permissionsFile)) {
        const raw = await fs.readJson(this.permissionsFile);
        // Validate structure to prevent prototype pollution
        this.rules = {
          tools: Object.fromEntries(
            Object.entries(raw.tools && typeof raw.tools === 'object' ? raw.tools : {})
              .filter(([name, value]) => /^[a-z][a-z0-9_-]*$/i.test(name) && (value === 'allow' || value === 'deny')),
          ),
          paths: {},
        };
      }
    } catch (e) {
      // Log but don't throw - corrupted permissions shouldn't break the agent
      console.debug?.(`Failed to load permissions: ${e.message}`);
    }
  }

  async save() {
    try {
      await fs.ensureDir(path.dirname(this.permissionsFile));
      // Only save known keys to prevent bloat
      const sanitized = {
        tools: Object.fromEntries(
          Object.entries(this.rules.tools).filter(([, v]) => v === 'allow' || v === 'deny')
        ),
        paths: this.rules.paths,
      };
      await fs.writeJson(this.permissionsFile, sanitized, { spaces: 2 });
    } catch (e) {
      console.debug?.(`Failed to save permissions: ${e.message}`);
      /* best effort */
    }
  }

  /**
   * Reset all persisted and session permissions.
   * Useful for testing or when user wants a clean slate.
   */
  async resetAll() {
    this.rules = { tools: {}, paths: {} };
    this.sessionAlways.clear();
    try {
      await fs.remove(this.permissionsFile);
    } catch {
      /* ignore */
    }
  }

  mode() {
    if (typeof this.config.autoApprove === 'boolean') return this.config.autoApprove ? 'allow' : 'ask';
    return this.config.permissionMode || 'ask';
  }

  // Persist an "always allow" decision for a tool (and command/path scope).
  async remember(name, args = {}) {
    this.sessionAlways.add(name);
    this.rules.tools[name] = 'allow';
    await this.save();
  }

  resetSession() {
    this.sessionAlways.clear();
  }

  workspaceRoots() {
    const roots = [this.cwd, ...(this.config.allowedPaths || [])];
    return roots.map((r) => resolvePath(this.cwd, r));
  }

  async pathDecision(name, args = {}) {
    const candidates = [];
    if (args.path) candidates.push(args.path);
    if (args.from) candidates.push(args.from);
    if (args.to) candidates.push(args.to);
    if (Array.isArray(args.edits)) for (const e of args.edits) if (e.path) candidates.push(e.path);
    if (Array.isArray(args.files)) candidates.push(...args.files);
    if (typeof args.diff === 'string') {
      for (const file of parseUnifiedDiff(args.diff)) if (file.path) candidates.push(file.path);
    }
    for (const cand of candidates) {
      if (typeof cand !== 'string' || !cand.trim()) return 'deny';
      let abs;
      try {
        abs = await resolveRealPath(resolvePath(this.cwd, cand));
      } catch {
        return 'deny';
      }
      let denied = false;
      for (const deniedPath of this.config.deniedPaths || []) {
        try {
          if (isWithin(await resolveRealPath(resolvePath(this.cwd, deniedPath)), abs)) {
            denied = true;
            break;
          }
        } catch {
          // An invalid deny rule must never turn into an allow.
          return 'deny';
        }
      }
      if (denied) return 'deny';
      if (isSensitivePath(abs)) return 'sensitive';
      let allowed = false;
      for (const root of this.workspaceRoots()) {
        try {
          if (isWithin(await resolveRealPath(root), abs)) {
            allowed = true;
            break;
          }
        } catch {
          // Missing roots cannot grant access.
        }
      }
      if (!allowed) return 'outside';
    }
    return null;
  }

  // Returns { decision: 'allow'|'ask'|'deny', reason }.
  async check({ name, args = {}, tool }) {
    await this.load();
    if ((this.config.deniedTools || []).includes(name) || this.rules.tools[name] === 'deny') {
      return { decision: 'deny', reason: 'tool denied by config or saved rule' };
    }

    const pathVerdict = await this.pathDecision(name, args);
    if (pathVerdict === 'deny') return { decision: 'deny', reason: 'path denied by config' };
    if (pathVerdict === 'sensitive') return { decision: 'ask', reason: 'sensitive path may contain credentials' };
    if (pathVerdict === 'outside') return { decision: 'ask', reason: 'path outside workspace' };

    if (this.rules.tools[name] === 'allow' || this.sessionAlways.has(name)) return { decision: 'allow', reason: 'remembered' };
    if ((this.config.allowedTools || []).includes(name)) return { decision: 'allow', reason: 'tool allowlisted' };

    const mode = this.mode();
    if (mode === 'deny') return { decision: 'deny', reason: 'permission mode is deny' };
    if (!tool || !tool.mutating) return { decision: 'allow', reason: 'read-only tool' };
    if (mode === 'allow') return { decision: 'allow', reason: 'auto-approved' };
    return { decision: 'ask', reason: 'mutating tool' };
  }

  // Backwards-compatible boolean helper.
  requiresApproval(toolName, tool) {
    if (this.rules.tools[toolName] === 'allow' || this.sessionAlways.has(toolName)) return false;
    if ((this.config.deniedTools || []).includes(toolName)) return false;
    if ((this.config.allowedTools || []).includes(toolName)) return false;
    if (this.mode() !== 'ask') return false;
    return Boolean(tool && tool.mutating);
  }
}

// Resolve existing symlinks, including a final dangling symlink, while still
// permitting paths that have not been created yet.
async function resolveRealPath(value) {
  const absolute = path.resolve(value);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    let stat;
    try { stat = await fs.lstat(absolute); } catch { stat = null; }
    if (stat?.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      return resolveRealPath(path.isAbsolute(target) ? target : path.resolve(path.dirname(absolute), target));
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(await resolveRealPath(parent), path.basename(absolute));
  }
}

// Build a compact, human-readable preview (command, path, or unified diff)
// shown to the user before approving a mutating tool call.
export function buildPermissionPreview(name, args = {}) {
  if (name === 'bash') return { kind: 'command', lines: [String(args.command || '')] };
  if (args.diff && typeof args.diff === 'string') return { kind: 'diff', lines: args.diff.split('\n') };
  if (args.path) return { kind: 'path', lines: [`${name} ${args.path}`] };
  if (args.edits) return { kind: 'diff', lines: args.edits.map((e) => `${e.path}: replace ${JSON.stringify(String(e.oldString || '').slice(0, 60))}`) };
  return { kind: 'json', lines: [JSON.stringify(args)] };
}
