import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ProviderClient } from '../client/provider-client.js';
import { ConfigLoader } from '../config/loader.js';
import { SessionStore } from '../session/store.js';
import { AgentCore } from './agent-core.js';
import { EVENT } from './events.js';

// Public, in-process embedding surface for the local agent core.
//
// Any UI (a terminal, an editor panel, a custom desktop shell) can embed the
// full opencode-style tool loop by calling `createAgent()` and rendering the
// events it emits — no HTTP server or subprocess required:
//
//   const session = await createAgent({ cwd: process.cwd() });
//   session.on('event', (event) => render(event));
//   session.on('permission', async (request) => 'allow');
//   await session.chat('refactor the router');
//
// The facade owns the pieces the raw AgentCore does not: config loading +
// persistence, the session store, and the current session id. Everything else
// (tools, skills, subagents, checkpoints, permissions, models) is exposed by
// delegation so a host UI can build pickers and panels on top of it.
export class AgentSession extends EventEmitter {
  constructor({ agent, client, config, configLoader, sessionStore, cwd }) {
    super();
    this.agent = agent;
    this.client = client;
    this.config = config;
    this.configLoader = configLoader;
    this.sessionStore = sessionStore;
    this.cwd = cwd;
    this.sessionId = randomUUID();
    this._permissionHandler = null;
    this._busy = false;
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  // The host UI registers a handler that resolves to 'allow' | 'always' | 'deny'.
  onPermission(handler) {
    this._permissionHandler = handler;
    return this;
  }

  // ── Conversation ──────────────────────────────────────────────────────────
  get busy() {
    return this._busy;
  }

  // Run one user turn through the full agentic loop. Streams every AgentCore
  // event to `event` listeners and returns the final assistant text.
  async chat(message, opts = {}) {
    if (this._busy) throw new Error('A turn is already running. Call cancel() first.');
    this._busy = true;
    const sessionId = opts.sessionId || this.sessionId;
    try {
      return await this.agent.chat({
        message,
        sessionId,
        onEvent: (event) => this.emit('event', event),
        onPermission: (request) =>
          this._permissionHandler ? this._permissionHandler(request) : Promise.resolve('allow'),
      });
    } finally {
      this._busy = false;
    }
  }

  cancel() {
    this.agent.cancel();
    this.emit('event', { type: EVENT.WARNING, text: 'Cancelling…' });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────
  newSession() {
    this.agent.resetSession(this.sessionId);
    this.agent.permissions.resetSession();
    this.sessionId = randomUUID();
    return this.sessionId;
  }

  currentSession() {
    return this.agent.getOrCreateSession(this.sessionId);
  }

  async listSessions() {
    return this.sessionStore ? this.sessionStore.list() : [];
  }

  async loadSession(id) {
    const sess = await this.agent.loadSession(id);
    if (sess) this.sessionId = sess.id;
    return sess;
  }

  async forkSession(id = this.sessionId) {
    if (!this.sessionStore) return null;
    const current = this.agent.getOrCreateSession(id);
    await this.agent.persistSession(current);
    const forked = await this.sessionStore.fork(id, randomUUID());
    if (forked) this.sessionId = forked.id;
    return forked;
  }

  async deleteSession(id) {
    return this.sessionStore ? this.sessionStore.remove(id) : false;
  }

  // ── Configuration ─────────────────────────────────────────────────────────
  setConfig(patch = {}, { persist = false } = {}) {
    Object.assign(this.config, patch);
    this.client.setConfig(this.config);
    this.agent.setConfig(this.config);
    return persist ? this.configLoader.save(this.config) : Promise.resolve(null);
  }

  async setModel(model) {
    await this.setConfig({ model: model || 'auto' }, { persist: this.config.autoSave !== false });
    this.emit('event', { type: EVENT.WARNING, text: `Model set to ${model || 'auto'}.` });
  }

  async setPermissionMode(mode) {
    if (!['allow', 'ask', 'deny'].includes(mode)) throw new Error(`Unknown permission mode "${mode}".`);
    this.config.permissionMode = mode;
    delete this.config.autoApprove;
    await this.setConfig({ permissionMode: mode }, { persist: this.config.autoSave !== false });
    return mode;
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.agent.setCwd(cwd);
    return cwd;
  }

  // ── Introspection (for pickers/panels) ────────────────────────────────────
  tools() {
    return this.agent.registry.describe();
  }

  async skills() {
    return this.agent.skills.list();
  }

  subagents() {
    return this.agent.subagents.list();
  }

  checkpoints() {
    return {
      list: () => this.agent.checkpoints.list(this.sessionId),
      undo: () => this.agent.checkpoints.undo(this.sessionId),
      redo: () => this.agent.checkpoints.redo(this.sessionId),
      rewind: (n) => this.agent.checkpoints.rewind(this.sessionId, n),
    };
  }

  permissionMode() {
    return this.agent.permissions.mode();
  }

  async models() {
    return this.client.models();
  }

  async health() {
    return this.client.health();
  }
}

// Create and wire a fully-capable in-process agent. Loads project/global config
// unless `config` is supplied, then constructs the Worker client, session store
// and AgentCore.
export async function createAgent(opts = {}) {
  const baseCwd = opts.cwd || process.cwd();
  const configLoader = opts.configLoader || new ConfigLoader({ cwd: baseCwd, binDir: opts.binDir });

  let config = opts.config;
  if (!config) {
    const loaded = await configLoader.load();
    config = loaded.config;
  } else {
    config = { ...config };
  }
  if (!config.workerUrl) config.workerUrl = 'https://devops-ai-agent.ashokkunchla.workers.dev';

  const cwd = config.cwd || baseCwd;
  const client = opts.client || new ProviderClient();
  client.setConfig(config);

  const agent = new AgentCore({ client, cwd, config });
  const sessionStore = opts.sessionStore || new SessionStore({ dir: config.sessionsDir });
  agent.setSessionStore(sessionStore);

  return new AgentSession({ agent, client, config, configLoader, sessionStore, cwd });
}

export default createAgent;
