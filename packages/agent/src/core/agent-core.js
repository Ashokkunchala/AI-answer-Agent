import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../tools/tool-registry.js';
import { buildSystemPrompt } from './system-prompt.js';
import { PermissionManager } from './permissions.js';
import { formatTodos } from './todos.js';
import { findCheckCommand } from './post-check.js';

const MAX_HISTORY = 80;
const EDIT_TOOLS = new Set(['write', 'edit']);
const PROJECT_ANALYSIS = /\b(understand|analyse|analyze|explore|overview|architecture|map|audit|review)\b[\s\S]*\b(project|repo|repository|codebase|all files)\b|\b(project|repo|repository|codebase)\b[\s\S]*\b(all files|overview|architecture)\b/i;

function safeParseArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: String(raw) };
  }
}

// Accumulate OpenAI streaming tool-call fragments (indexed deltas).
function mergeToolCallDeltas(acc, deltas) {
  for (const delta of deltas) {
    const index = delta.index ?? acc.length;
    if (!acc[index]) {
      acc[index] = { id: delta.id || `call_${index}`, type: 'function', function: { name: '', arguments: '' } };
    }
    if (delta.id) acc[index].id = delta.id;
    if (delta.function?.name) acc[index].function.name = delta.function.name;
    if (delta.function?.arguments) acc[index].function.arguments += delta.function.arguments;
  }
}

export class AgentCore {
  constructor(opts = {}) {
    this.client = opts.client;
    this.config = opts.config || {};
    this.cwd = opts.cwd || process.cwd();
    this.sessions = new Map();
    this.sessionStore = opts.sessionStore || null;
    this.permissions = new PermissionManager(this.config);
    this.registry = new ToolRegistry({ cwd: this.cwd, enabled: this.config.tools !== false });
    this.registry.setSubagent((args) => this.runSubagent(args));
    this.cancelled = false;
    this._onPermission = null;
  }

  setConfig(cfg) {
    this.config = cfg;
    this.registry.enabled = cfg.tools !== false;
    this.permissions.setConfig(cfg);
  }

  setCwd(cwd) {
    this.cwd = cwd;
    this.registry = new ToolRegistry({ cwd, enabled: this.config.tools !== false });
    this.registry.setSubagent((args) => this.runSubagent(args));
  }

  setSessionStore(store) {
    this.sessionStore = store;
  }

  getOrCreateSession(id) {
    const sid = id || randomUUID();
    if (!this.sessions.has(sid)) {
      this.sessions.set(sid, {
        id: sid,
        messages: [],
        system: null,
        todos: [],
        title: '',
        createdAt: new Date().toISOString(),
      });
    }
    return this.sessions.get(sid);
  }

  resetSession(id) {
    this.sessions.delete(id);
  }

  // Load a previously persisted session from disk into memory.
  async loadSession(id) {
    if (!this.sessionStore) return null;
    const data = await this.sessionStore.load(id);
    if (!data) return null;
    const sess = {
      id: data.id || id,
      messages: Array.isArray(data.messages) ? data.messages : [],
      system: null,
      todos: Array.isArray(data.todos) ? data.todos : [],
      title: data.title || '',
      createdAt: data.createdAt || new Date().toISOString(),
    };
    this.sessions.set(sess.id, sess);
    return sess;
  }

  async persistSession(sess) {
    if (!this.sessionStore || !sess) return;
    try {
      await this.sessionStore.save({
        id: sess.id,
        title: sess.title,
        cwd: this.cwd,
        model: this.config.model,
        todos: sess.todos,
        messages: sess.messages,
        createdAt: sess.createdAt,
      });
    } catch {
      /* persistence is best-effort */
    }
  }

  async ensureSystem(sess) {
    if (!sess.system) {
      sess.system = await buildSystemPrompt({
        cwd: this.cwd,
        tools: this.registry.schemas(),
        model: this.config.model,
        extra: this.config.systemPrompt,
      });
    }
    return sess.system;
  }

  trimHistory(sess) {
    if (sess.messages.length <= MAX_HISTORY) return;
    let cut = sess.messages.length - MAX_HISTORY;
    // Never start history on a `tool` message (must follow its assistant turn).
    while (cut < sess.messages.length && sess.messages[cut].role === 'tool') cut++;
    sess.messages = sess.messages.slice(cut);
  }

  // Main entry. Runs the full agentic loop for one user turn.
  async chat({ message, sessionId, onEvent, onPermission }) {
    const sess = this.getOrCreateSession(sessionId);
    this._onPermission = onPermission || null;
    if (message) {
      sess.messages.push({ role: 'user', content: message });
      if (!sess.title) sess.title = String(message).replace(/\s+/g, ' ').trim().slice(0, 80);
      await this.addProjectMapWhenRequested(sess, message, onEvent);
    }
    try {
      return await this.runLoop(sess, onEvent);
    } finally {
      await this.persistSession(sess);
      this._onPermission = null;
    }
  }

  // Project-wide questions are common and should not depend on a model making
  // dozens of fragile directory-list calls. Give it a compact, deterministic
  // inventory first, then it can read the relevant manifests and source.
  async addProjectMapWhenRequested(sess, message, onEvent) {
    if (!PROJECT_ANALYSIS.test(message) || this.config.tools === false) return;
    const tool = this.registry.get('projectmap');
    if (!tool) return;
    onEvent?.({ type: 'tool_start', name: 'projectmap', args: {}, id: 'preflight_projectmap' });
    const result = await this.registry.execute('projectmap', {});
    onEvent?.({ type: 'tool_end', name: 'projectmap', result, id: 'preflight_projectmap' });
    const evidence = [result.output];
    // Give the model the two root documents that define most JavaScript
    // projects. This makes a natural-language "understand this project"
    // request useful even when the selected model is conservative about
    // initiating further file reads.
    const rootFiles = ['README.md', 'package.json'];
    onEvent?.({ type: 'tool_start', name: 'glob', args: { pattern: '**/package.json' }, id: 'preflight_manifests' });
    const manifestSearch = await this.registry.execute('glob', { pattern: '**/package.json' });
    onEvent?.({ type: 'tool_end', name: 'glob', result: manifestSearch, id: 'preflight_manifests' });
    const manifests = (manifestSearch.output || '')
      .split(/\r?\n/)
      .filter((file) => /[\\/]package\.json$/i.test(file))
      .filter((file) => !/[\\/]node_modules[\\/]/i.test(file))
      .slice(0, 12);
    for (const file of [...new Set([...rootFiles, ...manifests])]) {
      onEvent?.({ type: 'tool_start', name: 'read', args: { path: file, limit: 500 }, id: `preflight_${file}` });
      const read = await this.registry.execute('read', { path: file, limit: 500 });
      if (!read.metadata?.error && !/^Error\b/.test(read.output || '')) {
        onEvent?.({ type: 'tool_end', name: 'read', result: read, id: `preflight_${file}` });
        evidence.push(`\n## ${file}\n${read.output}`);
      } else {
        onEvent?.({ type: 'tool_end', name: 'read', result: read, id: `preflight_${file}` });
      }
    }
    sess.messages.push({
      role: 'system',
      content: `[project inventory and root-project evidence generated for this request]\n${evidence.join('\n')}\n\nUse this as your starting point. Inspect relevant package manifests and entry points before describing architecture; do not claim that a root listing alone explains the project.`,
    });
  }

  async requestPermission(request) {
    if (!this._onPermission) return 'allow';
    try {
      const decision = await this._onPermission(request);
      return decision || 'allow';
    } catch {
      return 'deny';
    }
  }

  async runPostCheck(onEvent) {
    const check = await findCheckCommand(this.cwd);
    if (!check) return null;
    onEvent?.({ type: 'check_start', label: check.label, command: check.command });
    const bash = this.registry.get('bash');
    const res = await bash.run({ command: check.command, timeout: 180000 });
    const code = res.metadata?.code ?? 0;
    onEvent?.({ type: 'check_end', label: check.label, command: check.command, code, output: res.output });
    return { failed: code !== 0, code, output: res.output, command: check.command };
  }

  async runLoop(sess, onEvent, depth = 0) {
    const system = await this.ensureSystem(sess);
    const toolsEnabled = this.config.tools !== false;
    const maxSteps = this.config.maxSteps || 25;
    this.cancelled = false;
    let edited = false;
    let checkRan = false;

    // Wire the plan tool to this session for the duration of the turn.
    this.registry.setTodoHandler((todos) => {
      sess.todos = todos;
      onEvent?.({ type: 'todos', todos });
      return { title: 'plan', output: formatTodos(todos), metadata: { todos } };
    });

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelled) return '(cancelled)';
      onEvent?.({ type: 'step', current: step + 1, total: maxSteps, message: step === 0 ? 'Planning and investigating' : 'Continuing the task' });
      this.trimHistory(sess);
      const systemWithPlan = sess.todos?.length
        ? `${system}\n\n## Current plan\n${formatTodos(sess.todos)}`
        : system;
      const messages = [{ role: 'system', content: systemWithPlan }, ...sess.messages];
      const tools = toolsEnabled ? this.registry.schemas() : [];

      let content = '';
      let toolCalls = [];

      // Buffered calls are used whenever tools are in play (Workers AI only
      // returns reliable tool_calls in non-streaming mode) or when the user
      // has disabled streaming.
      if (tools.length || this.config.streaming === false) {
        const res = await this.client.chat({
          messages,
          tools: tools.length ? tools : undefined,
          model: this.config.model,
          temperature: this.config.temperature,
          task_type: this.taskTypeFor(sess),
        });
        const choice = res?.choices?.[0] || {};
        content = choice.message?.content || '';
        toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
        if (content) onEvent?.({ type: 'content', text: content });
      } else {
        for await (const chunk of this.client.streamChat({
          messages,
          model: this.config.model,
          temperature: this.config.temperature,
        })) {
          const delta = chunk?.choices?.[0]?.delta || {};
          if (delta.content) {
            content += delta.content;
            onEvent?.({ type: 'content', text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) mergeToolCallDeltas(toolCalls, delta.tool_calls);
        }
        toolCalls = toolCalls.filter(Boolean);
      }

      if (toolCalls.length) {
        sess.messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });
        for (const call of toolCalls) {
          const name = call.function?.name || 'unknown';
          const args = safeParseArguments(call.function?.arguments);
          const tool = this.registry.get(name);

          let decision = 'allow';
          if (this.permissions.requiresApproval(name, tool)) {
            decision = await this.requestPermission({ name, args, tool });
          }

          if (decision === 'deny') {
            onEvent?.({ type: 'tool_start', name, args, id: call.id });
            const denied = { title: name, output: `Permission denied by user for ${name}.`, metadata: { error: true, denied: true } };
            onEvent?.({ type: 'tool_end', name, result: denied, id: call.id });
            sess.messages.push({ role: 'tool', tool_call_id: call.id, name, content: denied.output });
            continue;
          }
          if (decision === 'always') this.permissions.remember(name);

          onEvent?.({ type: 'tool_start', name, args, id: call.id });
          const result = await this.registry.execute(name, args);
          onEvent?.({ type: 'tool_end', name, result, id: call.id });
          if (EDIT_TOOLS.has(name) && !result.metadata?.error) edited = true;
          sess.messages.push({ role: 'tool', tool_call_id: call.id, name, content: result.output });
        }
        continue;
      }

      // About to finish: run the project's check once if we changed code.
      if (edited && !checkRan && this.config.autoCheck !== false) {
        checkRan = true;
        const check = await this.runPostCheck(onEvent);
        if (check && check.failed) {
          sess.messages.push({
            role: 'system',
            content: `[auto-check] \`${check.command}\` failed (exit ${check.code}). Fix the errors before finishing.\n\n${check.output}`,
          });
          continue;
        }
      }

      sess.messages.push({ role: 'assistant', content });
      return content;
    }

    return '(reached the maximum number of steps without a final answer)';
  }

  taskTypeFor(sess) {
    const lastUser = [...sess.messages].reverse().find((message) => message.role === 'user');
    return lastUser && PROJECT_ANALYSIS.test(String(lastUser.content || '')) ? 'review' : undefined;
  }

  async runSubagent({ description = '', prompt }) {
    const sub = this.getOrCreateSession(`sub:${randomUUID()}`);
    sub.system =
      (await buildSystemPrompt({ cwd: this.cwd, tools: this.registry.schemas(), model: this.config.model })) +
      `\n\nYou are a sub-agent invoked to complete a single self-contained task. Do the work using tools and then report the result concisely. Do not ask follow-up questions.`;
    sub.messages.push({ role: 'user', content: prompt });
    const prevPermission = this._onPermission;
    this._onPermission = null; // sub-agents run without extra prompts
    try {
      return await this.runLoop(sub, null, 1);
    } finally {
      this._onPermission = prevPermission;
      this.sessions.delete(sub.id);
    }
  }
}
