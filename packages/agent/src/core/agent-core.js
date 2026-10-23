import { randomUUID } from 'node:crypto';
import { ToolRegistry } from '../tools/tool-registry.js';
import { buildSystemPrompt } from './system-prompt.js';
import { PermissionManager, buildPermissionPreview } from './permissions.js';
import { formatTodos } from './todos.js';
import { findCheckCommand } from './post-check.js';
import { classifyForProjectAnalysis, PROJECT_ANALYSIS } from './intent.js';
import { SkillLoader } from '../skills/loader.js';
import { CheckpointManager, affectedPaths } from '../session/checkpoints.js';
import { SubagentManager } from '../subagent/subagent.js';
import { getSubagentType } from '../subagent/types.js';
import { EVENT, scopeEvents } from './events.js';

const EDIT_TOOLS = new Set(['write', 'edit', 'patch', 'mkdir', 'move', 'delete']);
const DEFAULT_MAX_HISTORY = 80;
const SIMPLE_GREETING = /^(?:hi|hello|hey|hiya|howdy|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|you\s+there)[.!?\s]*$/i;

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
    this.permissions = new PermissionManager(this.config, { cwd: this.cwd });
    this.skills = new SkillLoader({ cwd: this.cwd, enabled: this.config.skills !== false, dirs: this.config.skillDirs });
    this.checkpoints = new CheckpointManager({ cwd: this.cwd, enabled: this.config.checkpoints !== false, dir: this.config.checkpointsDir });
    this.subagents = new SubagentManager({ agent: this });
    this._buildRegistry();
    this.cancelled = false;
    this._onPermission = null;
    this._abort = null;
    this._activeOnEvent = null;
    this._permissionQueue = Promise.resolve();
  }

  _buildRegistry() {
    this.registry = new ToolRegistry({ cwd: this.cwd, enabled: this.config.tools !== false, config: this.config });
    this.registry.setSubagent((args) => this.runSubagentFromTool(args));
    this.registry.setSkillLoader(this.skills);
  }

  setConfig(cfg) {
    this.config = cfg;
    for (const sess of this.sessions.values()) sess.system = null;
    this.permissions.setConfig(cfg);
    this.skills.enabled = cfg.skills !== false;
    this.skills.setExtraDirs(cfg.skillDirs);
    this.checkpoints.enabled = cfg.checkpoints !== false;
    this._buildRegistry();
  }

  setCwd(cwd) {
    this.cwd = cwd;
    for (const sess of this.sessions.values()) sess.system = null;
    this.permissions.setCwd(cwd);
    this.skills.setCwd(cwd);
    this.checkpoints.setCwd(cwd);
    this._buildRegistry();
  }

  setSessionStore(store) {
    this.sessionStore = store;
  }

  // Abort an in-flight turn (cancels the network request and running tools).
  cancel() {
    this.cancelled = true;
    try {
      this._abort?.abort();
    } catch {
      /* ignore */
    }
  }

  getOrCreateSession(id) {
    const sid = id || randomUUID();
    if (!this.sessions.has(sid)) {
      this.sessions.set(sid, {
        id: sid,
        messages: [],
        system: null,
        summary: '',
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
      summary: data.summary || '',
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
        summary: sess.summary,
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
      const catalog = await this.skills.catalog();
      sess.system =
        (await buildSystemPrompt({
          cwd: this.cwd,
          tools: this.registry.schemas(),
          model: this.config.model,
          extra: this.config.systemPrompt,
        })) + catalog;
    }
    return sess.system;
  }

  buildContextMessages(sess, extraInstruction) {
    const parts = [sess.system];
    if (sess.summary) parts.push(`## Summary of earlier conversation\n${sess.summary}`);
    if (sess.todos?.length) parts.push(`## Current plan\n${formatTodos(sess.todos)}`);
    if (extraInstruction) parts.push(extraInstruction);
    return [{ role: 'system', content: parts.filter(Boolean).join('\n\n') }, ...sess.messages];
  }

  // Compress old history into a running summary when it grows too large.
  async maybeCompact(sess, onEvent) {
    const maxHistory = this.config.maxHistory || DEFAULT_MAX_HISTORY;
    if (this.config.summarize === false || sess.messages.length <= maxHistory) return;
    const keep = Math.max(10, Math.floor(maxHistory / 2));
    let cut = sess.messages.length - keep;
    while (cut < sess.messages.length && sess.messages[cut].role !== 'user') cut++;
    const dropped = sess.messages.slice(0, cut);
    if (!dropped.length) return;
    const summary = await this.summarizeMessages(dropped);
    sess.summary = sess.summary ? `${sess.summary}\n${summary}` : summary;
    sess.messages = sess.messages.slice(cut);
    onEvent?.({ type: EVENT.WARNING, text: `Compacted ${dropped.length} earlier messages into a summary.` });
  }

  async summarizeMessages(messages) {
    const transcript = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role}: ${String(m.content || '').slice(0, 400)}`)
      .join('\n');
    try {
      const res = await this.client.chat({
        messages: [
          { role: 'system', content: 'Summarize this coding conversation for another agent. Capture decisions, files changed, commands run, and open questions. Be concise (<=200 words).' },
          { role: 'user', content: transcript },
        ],
        model: this.config.model,
        temperature: 0.1,
        max_tokens: 400,
      });
      const text = res?.choices?.[0]?.message?.content;
      if (text) return text.trim();
    } catch (e) {
      // Log the error for debugging but fall back to heuristic
      console.debug?.(`Summarization failed, using heuristic fallback: ${e.message}`);
    }
    return transcript.slice(0, 1500);
  }

  // Main entry. Runs the full agentic loop for one user turn.
  async chat({ message, sessionId, onEvent, onPermission }) {
    const sess = this.getOrCreateSession(sessionId);
    this.cancelled = false;
    this._abort = new AbortController();
    this._onPermission = onPermission || null;
    this._activeOnEvent = onEvent || null;
    if (message) {
      sess.messages.push({ role: 'user', content: message });
      if (!sess.title) sess.title = String(message).replace(/\s+/g, ' ').trim().slice(0, 80);
      if (sess.messages.length === 1 && SIMPLE_GREETING.test(String(message).trim())) {
        const reply = /^(?:thanks|thank\s+you)/i.test(message.trim())
          ? "You're welcome! What would you like to work on next?"
          : "Hi! I'm here. What would you like to work on?";
        sess.messages.push({ role: 'assistant', content: reply });
        onEvent?.({ type: EVENT.CONTENT, text: reply });
        onEvent?.({ type: EVENT.DONE, content: reply });
        await this.persistSession(sess);
        this._onPermission = null;
        this._activeOnEvent = null;
        this._abort = null;
        return reply;
      }
      await this.addProjectMapWhenRequested(sess, message, onEvent);
    }
    let content = '';
    try {
      content = await this.runLoop(sess, onEvent);
      return content;
    } finally {
      onEvent?.({ type: EVENT.DONE, content });
      await this.persistSession(sess);
      this._onPermission = null;
      this._activeOnEvent = null;
      this._abort = null;
    }
  }

  // Project-wide questions are common and should not depend on a model making
  // dozens of fragile directory-list calls.
  async addProjectMapWhenRequested(sess, message, onEvent) {
    if (!classifyForProjectAnalysis(message) || this.config.tools === false) return;
    const run = async (name, args, id) => {
      onEvent?.({ type: EVENT.TOOL_START, name, args, id });
      const result = await this.registry.execute(name, args);
      onEvent?.({ type: EVENT.TOOL_END, name, result, id });
      return result;
    };
    const result = await run('projectmap', {}, 'preflight_projectmap');
    const evidence = [result.output];
    const manifestSearch = await run('glob', { pattern: '**/package.json' }, 'preflight_manifests');
    const manifests = (manifestSearch.output || '')
      .split(/\r?\n/)
      .filter((file) => /[\\/]package\.json$/i.test(file))
      .filter((file) => !/[\\/]node_modules[\\/]/i.test(file))
      .slice(0, 12);
    const rootFiles = ['README.md', 'package.json'];
    for (const file of [...new Set([...rootFiles, ...manifests])]) {
      const read = await run('read', { path: file, limit: 500 }, `preflight_${file}`);
      if (!read.metadata?.error && !/^Error\b/.test(read.output || '')) evidence.push(`\n## ${file}\n${read.output}`);
    }
    sess.messages.push({
      role: 'system',
      content: `[project inventory and root-project evidence generated for this request]\n${evidence.join('\n')}\n\nUse this as your starting point. Inspect relevant package manifests and entry points before describing architecture; do not claim that a root listing alone explains the project.`,
    });
  }

  async requestPermission(request) {
    const ask = async () => {
      if (!this._onPermission) return 'deny';
      this._activeOnEvent?.({ type: EVENT.PERMISSION_REQUEST, request });
      try {
        const result = await this._onPermission(request);
        const decision = result === true ? 'allow' : result === 'allow' || result === 'always' ? result : 'deny';
        this._activeOnEvent?.({ type: EVENT.PERMISSION_RESOLVED, name: request.name, decision });
        return decision;
      } catch (e) {
        console.debug?.(`Permission handler error: ${e.message}`);
        return 'deny';
      }
    };
    const pending = this._permissionQueue.then(ask, ask);
    this._permissionQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async runPostCheck(onEvent) {
    const check = await findCheckCommand(this.cwd);
    if (!check) return null;
    const bash = this.registry.get('bash');
    const verdict = await this.permissions.check({ name: 'bash', args: { command: check.command }, tool: bash });
    let decision = verdict.decision;
    if (decision === 'ask') {
      decision = await this.requestPermission({
        name: 'bash',
        args: { command: check.command },
        tool: bash,
        preview: buildPermissionPreview('bash', { command: check.command }),
        reason: `automatic ${check.label} check`,
      });
    }
    if (decision !== 'allow' && decision !== 'always') {
      return { skipped: true, command: check.command, reason: verdict.reason };
    }
    onEvent?.({ type: EVENT.CHECK_START, label: check.label, command: check.command });
    const res = await bash.run({ command: check.command, timeout: 180000, signal: this._abort?.signal });
    const code = res.metadata?.code ?? 0;
    onEvent?.({ type: EVENT.CHECK_END, label: check.label, command: check.command, code, output: res.output });
    return { failed: code !== 0, code, output: res.output, command: check.command };
  }

  // Resolve the tool schemas for a turn, optionally limited to a tool subset.
  toolSchemas(toolNames) {
    if (this.config.tools === false) return [];
    if (!toolNames) return this.registry.schemas();
    return this.registry.schemas().filter((s) => toolNames.includes(s.function?.name));
  }

  async runLoop(sess, onEvent, opts = {}) {
    const { toolNames = null, extraInstruction = null } = opts;
    const system = await this.ensureSystem(sess);
    void system;
    const maxSteps = this.config.maxSteps || 25;
    let edited = false;
    let checkRan = false;
    let reportedModel = null;
    let turnSummary = null;

    for (let step = 0; step < maxSteps; step++) {
      if (this.cancelled) return '(cancelled)';
      onEvent?.({ type: EVENT.STEP, current: step + 1, total: maxSteps, message: step === 0 ? 'Planning and investigating' : 'Continuing the task' });
      await this.maybeCompact(sess, onEvent);
      const messages = this.buildContextMessages(sess, extraInstruction);
      const tools = this.toolSchemas(toolNames);

      let content = '';
      let toolCalls = [];

      try {
        if (this.config.streaming === false) {
          const res = await this.client.chat({
            messages,
            tools: tools.length ? tools : undefined,
            model: this.config.model,
            temperature: this.config.temperature,
            task_type: this.taskTypeFor(sess),
            signal: this._abort?.signal,
          });
          const choice = res?.choices?.[0] || {};
          content = choice.message?.content || '';
          toolCalls = Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls : [];
          if (res?.model) onEvent?.({ type: EVENT.MODEL, model: res.model });
          turnSummary = {
            model: res?.model,
            usage: res?.usage,
            routing: res?.routing,
            latency_ms: res?._metadata?.latency_ms,
            task_type: res?._metadata?.task_type,
            task_label: res?._metadata?.task_label,
          };
          if (content) onEvent?.({ type: EVENT.CONTENT, text: content });
        } else {
          const body = {
            messages,
            model: this.config.model,
            temperature: this.config.temperature,
            task_type: this.taskTypeFor(sess),
            signal: this._abort?.signal,
          };
          if (tools.length) {
            body.tools = tools;
            if (this.config.toolStream !== false) body.tool_stream = true;
          }
          for await (const chunk of this.client.streamChat(body)) {
            if (chunk?.model && chunk.model !== reportedModel) {
              reportedModel = chunk.model;
              onEvent?.({ type: EVENT.MODEL, model: chunk.model });
            }
            if (chunk?.type === 'marker') {
              onEvent?.({ type: EVENT.MARKER, name: chunk.name, timestamp: chunk.timestamp });
              continue;
            }
            if (chunk?.usage || chunk?.routing || chunk?._metadata) {
              turnSummary = {
                model: chunk.model,
                usage: chunk.usage,
                routing: chunk.routing,
                latency_ms: chunk?._metadata?.latency_ms,
                task_type: chunk?._metadata?.task_type,
                task_label: chunk?._metadata?.task_label,
              };
            }
            const choice = chunk?.choices?.[0] || {};
            const delta = choice.delta || {};
            if (delta.content) {
              content += delta.content;
              onEvent?.({ type: EVENT.CONTENT, text: delta.content });
            }
            if (delta.reasoning) onEvent?.({ type: EVENT.REASONING, text: delta.reasoning });
            if (Array.isArray(delta.tool_calls)) {
              mergeToolCallDeltas(toolCalls, delta.tool_calls);
              onEvent?.({ type: EVENT.TOOL_ARGS, tool_calls: toolCalls.map((c) => ({ name: c.function?.name, arguments: c.function?.arguments })) });
            }
          }
          toolCalls = toolCalls.filter(Boolean);
        }
      } catch (e) {
        if (this.cancelled || e?.name === 'AbortError') return '(cancelled)';
        throw e;
      }

      if (toolCalls.length) {
        sess.messages.push({ role: 'assistant', content: content || '', tool_calls: toolCalls });
        for (const call of toolCalls) {
          if (this.cancelled) return '(cancelled)';
          const name = call.function?.name || 'unknown';
          const args = safeParseArguments(call.function?.arguments);
          await this.executeToolCall(sess, { name, args, id: call.id, onEvent });
          if (EDIT_TOOLS.has(name)) edited = true;
        }
        continue;
      }

      if (edited && !checkRan && this.config.autoCheck !== false) {
        checkRan = true;
        const check = await this.runPostCheck(onEvent);
        if (check?.skipped) {
          sess.messages.push({
            role: 'system',
            content: `[auto-check] did not run ${check.command} because approval was not granted. Do not claim the check passed.`,
          });
          continue;
        }
        if (check && check.failed) {
          sess.messages.push({
            role: 'system',
            content: `[auto-check] \`${check.command}\` failed (exit ${check.code}). Fix the errors before finishing.\n\n${check.output}`,
          });
          continue;
        }
      }

      if (turnSummary) onEvent?.({ type: EVENT.TURN, ...turnSummary });
      sess.messages.push({ role: 'assistant', content });
      return content;
    }

    return '(reached the maximum number of steps without a final answer)';
  }

  // Permission-check, checkpoint and run a single tool call.
  async executeToolCall(sess, { name, args, id, onEvent }) {
    const tool = this.registry.get(name);
    const verdict = await this.permissions.check({ name, args, tool });
    let decision = verdict.decision;

    if (decision === 'ask') {
      const preview = buildPermissionPreview(name, args);
      decision = await this.requestPermission({ name, args, tool, preview, reason: verdict.reason });
    }

    if (decision === 'deny') {
      onEvent?.({ type: EVENT.TOOL_START, name, args, id });
      const denied = { title: name, output: `Permission denied for ${name}.`, metadata: { error: true, denied: true } };
      onEvent?.({ type: EVENT.TOOL_END, name, result: denied, id });
      sess.messages.push({ role: 'tool', tool_call_id: id, name, content: denied.output });
      return;
    }
    if (decision === 'always') await this.permissions.remember(name, args);

    onEvent?.({ type: EVENT.TOOL_START, name, args, id });
    const paths = affectedPaths(this.cwd, name, args);
    let result;
    if (tool?.mutating && this.checkpoints.enabled && paths.length) {
      const wrapped = await this.checkpoints.wrap(sess.id, { label: name, paths, tool: name }, () => this.registry.execute(name, args));
      result = wrapped.result;
      if (wrapped.checkpoint) onEvent?.({ type: EVENT.CHECKPOINT, checkpoint: { id: wrapped.checkpoint.id, label: name, paths } });
    } else {
      result = await this.registry.execute(name, args);
    }
    if (name === 'todowrite' && Array.isArray(result.metadata?.todos)) {
      sess.todos = result.metadata.todos;
      onEvent?.({ type: EVENT.TODOS, todos: sess.todos });
    }
    onEvent?.({ type: EVENT.TOOL_END, name, result, id });
    sess.messages.push({ role: 'tool', tool_call_id: id, name, content: result.output });

    // Rebuild the registry if the tool changed capability surface (never here),
    // otherwise nothing to do.
  }

  taskTypeFor(sess) {
    const lastUser = [...sess.messages].reverse().find((message) => message.role === 'user');
    return lastUser && PROJECT_ANALYSIS.test(String(lastUser.content || '')) ? 'review' : undefined;
  }

  // Invoked by the `task` tool.
  runSubagentFromTool({ description, prompt, subagent_type, parallel }) {
    return this.runSubagent({ description, prompt, subagent_type, parallel });
  }

  // Run a typed sub-agent in an isolated session.
  async runSubagent({ description = '', prompt, subagent_type, onEvent }) {
    const resolved = getSubagentType(subagent_type);
    const sub = this.getOrCreateSession(`sub:${randomUUID()}`);
    const catalog = await this.skills.catalog();
    sub.system =
      (await buildSystemPrompt({ cwd: this.cwd, tools: this.toolSchemas(resolved.tools), model: this.config.model })) +
      catalog +
      `\n\n${resolved.instruction}`;
    sub.messages.push({ role: 'user', content: prompt });

    const scope = `sub:${sub.id.slice(4, 12)}`;
    const emitter = onEvent ? scopeEvents(onEvent, scope) : this._activeOnEvent ? scopeEvents(this._activeOnEvent, scope) : null;
    emitter?.({ type: EVENT.SUBAGENT_START, description: description || resolved.label, subagentType: resolved.label });

    const toolNames = resolved.tools || this.registry.list().filter((name) => name !== 'task');
    try {
      const output = await this.runLoop(sub, emitter, { toolNames, extraInstruction: resolved.instruction });
      emitter?.({ type: EVENT.SUBAGENT_END, description: description || resolved.label, subagentType: resolved.label });
      return output;
    } finally {
      this.sessions.delete(sub.id);
    }
  }
}
