import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput } from 'ink';
import { renderMarkdown } from './markdown.js';
import { EVENT } from '../core/events.js';

const h = React.createElement;

// ── Personal UI terminal ────────────────────────────────────────────────────
// A richer, opencode-style front end for the in-process agent core. It renders
// the full AgentCore event stream (streaming markdown, reasoning, tool calls
// with diffs, plan, permissions, checkpoints, sub-agents) and adds model /
// session / help overlays plus a status bar. It talks to the same
// `{ cli, agent, client, commands, config }` objects the CLI already wires up,
// so it can also be embedded by any host that constructs those.

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

const THEMES = {
  dark: { primary: 'cyan', dim: 'gray', accent: 'magenta', ok: 'green', warn: 'yellow', error: 'red', user: 'green' },
  light: { primary: 'blue', dim: 'gray', accent: 'magenta', ok: 'green', warn: 'yellow', error: 'red', user: 'blue' },
  mono: { primary: 'white', dim: 'gray', accent: 'white', ok: 'white', warn: 'white', error: 'white', user: 'white' },
};

export function resolveTheme(name) {
  if (name === 'light') return THEMES.light;
  if (name === 'mono') return THEMES.mono;
  return THEMES.dark;
}

export function stripAnsi(value) {
  return String(value).replace(ANSI, '');
}
function columns() {
  return process.stdout.columns || 80;
}
export function oneLine(value, max) {
  const line = stripAnsi(value).replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}
export function shortArgs(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
  try {
    return oneLine(JSON.stringify(args), Math.max(20, columns() - 14));
  } catch {
    return String(args);
  }
}
function useSpinner(active) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setFrame((value) => value + 1), 90);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER[frame % SPINNER.length];
}

// ── Transcript renderers ────────────────────────────────────────────────────

function DiffBlock({ diff, theme, expanded }) {
  if (!Array.isArray(diff) || !diff.length) return null;
  const limit = expanded ? diff.length : 12;
  const shown = diff.slice(0, limit);
  return h(
    Text,
    { color: theme.dim },
    shown
      .map((line) => {
        const text = oneLine(line.text, columns() - 10);
        if (line.type === 'add') return `     + ${text}`;
        if (line.type === 'del') return `     - ${text}`;
        return `       ${text}`;
      })
      .join('\n'),
  );
}

function ToolBlock({ item, spin, expanded, theme }) {
  const running = item.status === 'running';
  const failed = item.status === 'error';
  const color = failed ? theme.error : running ? theme.warn : theme.primary;
  const marker = running ? spin : failed ? '✗' : '⏺';
  const lines = stripAnsi(item.output || '')
    .split('\n')
    .filter((line, index, all) => line.length || index < all.length - 1)
    .slice(0, expanded ? 60 : 6);
  const hasDiff = Array.isArray(item.diff) && item.diff.length;
  return h(
    Box,
    { flexDirection: 'column', marginBottom: 0 },
    h(
      Text,
      { color },
      `  ${item.scope ? `${item.scope} ` : ''}${marker} `,
      h(Text, { bold: true }, item.name),
      shortArgs(item.args) ? h(Text, { color: theme.dim }, ` ${shortArgs(item.args)}`) : null,
    ),
    !running && hasDiff ? h(DiffBlock, { diff: item.diff, theme, expanded }) : null,
    !running &&
      (lines.length
        ? h(
            Text,
            { color: theme.dim },
            lines.map((line, index) => `     ${index === 0 ? '⎿ ' : '  '}${oneLine(line, columns() - 8)}`).join('\n'),
          )
        : hasDiff
          ? null
          : h(Text, { color: theme.dim }, '     ⎿ (no output)')),
  );
}

function AssistantText({ text }) {
  const nodes = renderMarkdown(text);
  return h(Box, { flexDirection: 'column' }, ...nodes);
}

function renderItem(item, spin, expanded, showReasoning, theme) {
  if (item.role === 'user') {
    return h(Box, { key: item.id }, h(Text, { color: theme.user, bold: true }, '› '), h(Text, null, item.text));
  }
  if (item.role === 'assistant') {
    return h(
      Box,
      { key: item.id, flexDirection: 'column', marginBottom: 0 },
      h(AssistantText, { text: item.text }),
    );
  }
  if (item.role === 'tool') return h(ToolBlock, { key: item.id, item, spin, expanded, theme });
  if (item.role === 'reasoning') {
    if (!showReasoning) return null;
    return h(Box, { key: item.id }, h(Text, { color: theme.dim, italic: true }, `  ✻ ${oneLine(item.text, columns() - 6)}`));
  }
  return h(
    Box,
    { key: item.id },
    h(
      Text,
      { color: item.role === 'error' ? theme.error : item.role === 'warning' ? theme.warn : theme.dim },
      item.text,
    ),
  );
}

// ── Panels ──────────────────────────────────────────────────────────────────

function PlanPanel({ todos, step, maxSteps, visible, theme }) {
  if (!visible) return null;
  const rows = todos.length
    ? todos.map((todo, index) => {
        const marker =
          todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'cancelled' ? '–' : '○';
        const color =
          todo.status === 'completed' ? theme.ok : todo.status === 'in_progress' ? theme.warn : theme.dim;
        return h(Text, { key: `${todo.content}-${index}`, color }, ` ${marker} ${todo.content}`);
      })
    : [h(Text, { key: 'empty', color: theme.dim }, ' No plan yet — multi-step tasks will create one here.')];
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.primary, paddingX: 1, marginBottom: 1 },
    h(Text, { color: theme.primary, bold: true }, `WORK PLAN${step ? ` · step ${step}/${maxSteps}` : ''}`),
    ...rows,
  );
}

function PermissionPanel({ request, theme }) {
  if (!request) return null;
  const preview = request.preview;
  const detail = request.args?.path || request.args?.command || request.args?.url || JSON.stringify(request.args || {});
  const previewLines = preview?.lines ? preview.lines.slice(0, 12) : [];
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'double', borderColor: theme.warn, paddingX: 1, marginBottom: 1 },
    h(Text, { color: theme.warn, bold: true }, `Permission required: ${request.name}${request.reason ? ` (${request.reason})` : ''}`),
    preview?.kind === 'diff' ? null : h(Text, { color: theme.dim }, oneLine(detail, columns() - 6)),
    previewLines.length ? h(Text, { color: theme.dim }, previewLines.map((l) => `  ${oneLine(l, columns() - 4)}`).join('\n')) : null,
    h(Text, null, ' y allow  ·  a always allow this tool  ·  n deny'),
  );
}

function CommandPalette({ items, filter, index, theme }) {
  const matches = items
    .filter((i) => i.name.slice(1).toLowerCase().startsWith(String(filter).replace(/^\//, '').toLowerCase()))
    .slice(0, 8);
  if (!matches.length) return null;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    ...matches.map((i, idx) =>
      h(
        Text,
        { key: i.name, color: idx === index ? theme.accent : theme.dim },
        `${idx === index ? '▸ ' : '  '}${i.name.padEnd(14)} ${i.description}`,
      ),
    ),
  );
}

function Overlay({ overlay, theme }) {
  if (!overlay) return null;
  let title = '';
  let rows = [];
  if (overlay.kind === 'models') {
    title = 'Select model';
    rows = overlay.loading
      ? [h(Text, { key: 'l', color: theme.dim }, ' loading models…')]
      : overlay.models.length
        ? overlay.models.map((m, idx) =>
            h(
              Text,
              { key: m.id + idx, color: idx === overlay.index ? theme.accent : theme.dim },
              `${idx === overlay.index ? '▸ ' : '  '}${String(m.id).padEnd(28)} ${oneLine(m.name || '', columns() - 40)}`,
            ),
          )
        : [h(Text, { key: 'e', color: theme.error }, ' no models returned')];
  } else if (overlay.kind === 'sessions') {
    title = 'Sessions';
    rows = overlay.sessions.length
      ? overlay.sessions.map((s, idx) =>
          h(
            Text,
            { key: s.id, color: idx === overlay.index ? theme.accent : s.id === overlay.activeId ? theme.ok : theme.dim },
            `${idx === overlay.index ? '▸ ' : '  '}${oneLine(s.title || s.id, 40).padEnd(42)} ${chalkless(s.updatedAt)}`,
          ),
        )
      : [h(Text, { key: 'e', color: theme.dim }, ' no saved sessions')];
  } else if (overlay.kind === 'help') {
    title = 'Help & shortcuts';
    rows = [
      ['enter', 'send message'],
      ['esc', 'cancel the current turn'],
      ['ctrl+c', 'cancel turn / quit when idle'],
      ['tab', 'expand tool output / complete command'],
      ['ctrl+p', 'toggle work plan panel'],
      ['ctrl+r', 'toggle reasoning display'],
      ['ctrl+l', 'clear the transcript'],
      ['ctrl+o', 'pick a model'],
      ['ctrl+s', 'switch / resume session'],
      ['ctrl+k', 'toggle this help'],
      ['/help', 'list all slash commands'],
    ].map(([k, v], idx) =>
      h(Text, { key: 'h' + idx, color: theme.dim }, `  ${String(k).padEnd(10)} ${v}`),
    );
  }
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    h(Text, { color: theme.accent, bold: true }, title),
    ...rows.slice(0, 14),
    h(Text, { color: theme.dim }, overlay.kind === 'help' ? ' press ctrl+k / esc to close' : ' ↑↓ move · enter select · esc close'),
  );
}

function chalkless(value) {
  return stripAnsi(value || '').slice(0, 19);
}

// A small, dependency-free single-line editor. Ink's text input inserts the
// bare letter for Ctrl shortcuts (Ctrl+P → "p", etc.), which corrupts the line
// while the App also handles those shortcuts. Owning the editor keeps the two
// in sync.
function InputLine({ value, cursor, placeholder, theme, focused }) {
  if (!value && placeholder && focused) {
    return h(Text, null, h(Text, { inverse: true, color: theme.dim }, placeholder[0]), h(Text, { color: theme.dim }, placeholder.slice(1)));
  }
  if (!focused) return h(Text, null, value || h(Text, { color: theme.dim }, ''));
  const before = value.slice(0, cursor);
  const at = value[cursor] || ' ';
  const after = value.slice(cursor + 1);
  return h(Text, null, before, h(Text, { inverse: true }, at), after);
}

// ── Main component ──────────────────────────────────────────────────────────

export function Terminal({ cli, agent, client, commands, config, moduleName = 'agent' }) {
  const { exit } = useApp();
  const theme = resolveTheme(config?.theme);
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState([]);
  const [step, setStep] = useState(0);
  const [showPlan, setShowPlan] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);
  const [expandedTools, setExpandedTools] = useState(false);
  const [permission, setPermission] = useState(null);
  const [commandItems, setCommandItems] = useState([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [overlay, setOverlay] = useState(null);
  const [sessionId, setSessionId] = useState(cli?.sessionId);
  const [model, setModel] = useState(config?.model || 'auto');
  const idRef = useRef(0);
  const liveAssistantRef = useRef(null);
  const permissionResolveRef = useRef(null);
  const spin = useSpinner(busy);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!commands?.names) return;
      try {
        const names = await commands.names();
        if (alive) setCommandItems(names);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [commands]);

  const push = (item) => setItems((previous) => [...previous, item]);
  const pushSystem = (text, role = 'system') => push({ id: `s${++idRef.current}`, role, text, done: true });

  const finalizeTurn = () => {
    const assistantId = liveAssistantRef.current;
    liveAssistantRef.current = null;
    setItems((previous) =>
      previous.map((item) => {
        if (item.id === assistantId) return { ...item, done: true };
        if (item.role === 'tool' && item.status === 'running') return { ...item, status: 'done', done: true };
        return item;
      }),
    );
  };

  const onEvent = (event) => {
    const scope = event.scope;
    if (event.type === EVENT.CONTENT) {
      let id = liveAssistantRef.current;
      if (!id) {
        id = `a${++idRef.current}`;
        liveAssistantRef.current = id;
        setItems((previous) => [...previous, { id, role: 'assistant', text: event.text, done: false, scope }]);
      } else {
        setItems((previous) =>
          previous.map((item) => (item.id === id ? { ...item, text: item.text + event.text } : item)),
        );
      }
    } else if (event.type === EVENT.REASONING) {
      setItems((previous) => {
        const last = previous[previous.length - 1];
        if (last && last.role === 'reasoning' && !last.done) {
          return previous.map((item, index) =>
            index === previous.length - 1 ? { ...item, text: item.text + event.text } : item,
          );
        }
        return [...previous, { id: `r${++idRef.current}`, role: 'reasoning', text: event.text, done: true, scope }];
      });
    } else if (event.type === EVENT.TOOL_START) {
      const assistantId = liveAssistantRef.current;
      liveAssistantRef.current = null;
      const id = `t${++idRef.current}`;
      setItems((previous) => [
        ...previous.map((item) => (item.id === assistantId ? { ...item, done: true } : item)),
        { id, role: 'tool', name: event.name, args: event.args, status: 'running', done: false, scope },
      ]);
    } else if (event.type === EVENT.TOOL_END) {
      setItems((previous) => {
        const index = previous
          .map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name && item.scope === scope)
          .lastIndexOf(true);
        const fallback =
          index < 0
            ? previous
                .map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name)
                .lastIndexOf(true)
            : index;
        if (fallback < 0) return previous;
        const output = event.result?.output || '';
        const next = previous.slice();
        next[fallback] = {
          ...next[fallback],
          status: event.result?.metadata?.error || /^Error\b/.test(output) ? 'error' : 'done',
          output,
          diff: event.result?.metadata?.diff,
          done: true,
        };
        return next;
      });
    } else if (event.type === EVENT.TODOS) setTodos(event.todos || []);
    else if (event.type === EVENT.STEP) setStep(event.current || 0);
    else if (event.type === EVENT.WARNING) pushSystem(event.text, 'warning');
    else if (event.type === EVENT.ERROR) pushSystem(event.text, 'error');
    else if (event.type === EVENT.CHECKPOINT)
      pushSystem(`checkpoint ${event.checkpoint?.id} saved (${event.checkpoint?.label})`);
    else if (event.type === EVENT.CHECK_START) pushSystem(`▸ running check: ${event.command}`);
    else if (event.type === EVENT.CHECK_END)
      pushSystem(`▸ check ${event.code === 0 ? 'passed' : `failed (exit ${event.code})`}: ${event.command}`);
    else if (event.type === EVENT.SUBAGENT_START)
      pushSystem(`↳ ${event.subagentType || 'subagent'}: ${event.description || ''}`);
    else if (event.type === EVENT.SUBAGENT_END) pushSystem(`↳ ${event.subagentType || 'subagent'} finished`);
  };

  const requestPermission = (request) =>
    new Promise((resolve) => {
      permissionResolveRef.current = resolve;
      setPermission(request);
    });
  const resolvePermission = (decision) => {
    const resolve = permissionResolveRef.current;
    permissionResolveRef.current = null;
    setPermission(null);
    resolve?.(decision);
  };

  const cancelAgent = () => {
    if (agent?.cancel) agent.cancel();
    else if (agent) agent.cancelled = true;
  };

  const runCommand = async (line) => {
    if (line === '/exit' || line === '/quit') return exit();
    const original = { log: console.log, error: console.error };
    const logs = [];
    const sink = (...args) => logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    console.log = sink;
    console.error = sink;
    setBusy(true);
    let result;
    try {
      result = await commands.handle(line);
    } catch (error) {
      logs.push(`Error: ${error.message}`);
    } finally {
      console.log = original.log;
      console.error = original.error;
      setBusy(false);
    }
    if (result === 'exit') return exit();
    if (logs.length) pushSystem(logs.map(stripAnsi).join('\n'));
    // Slash commands may have changed session/model/cwd — refresh the chrome.
    setSessionId(cli?.sessionId);
    setModel(config?.model || 'auto');
    if (result && typeof result === 'object' && result.prompt) await runPrompt(result.prompt);
  };

  const runPrompt = async (line) => {
    push({ id: `u${++idRef.current}`, role: 'user', text: line, done: true });
    setBusy(true);
    setStep(0);
    try {
      await agent.chat({ message: line, sessionId: cli.sessionId, onEvent, onPermission: requestPermission });
    } catch (error) {
      pushSystem(`Error: ${error.message}`, 'error');
    } finally {
      finalizeTurn();
      setStep(0);
      setBusy(false);
    }
  };

  const submit = async (value) => {
    const line = value.trim();
    setInput('');
    setCursor(0);
    setPaletteIndex(0);
    if (!line || permission || overlay) return;
    if (busy) return pushSystem('Still working — press Esc to cancel the current turn.');
    if (line.startsWith('/')) return runCommand(line);
    await runPrompt(line);
  };

  const openModels = async () => {
    setOverlay({ kind: 'models', loading: true, models: [], index: 0 });
    const models = (await (client?.models?.() || cli?.client?.models?.() || Promise.resolve([]))) || [];
    setOverlay((current) => (current?.kind === 'models' ? { ...current, loading: false, models, index: 0 } : current));
  };

  const openSessions = async () => {
    const sessions = (await (cli?.sessionStore?.list?.() || Promise.resolve([]))) || [];
    setOverlay({ kind: 'sessions', sessions, index: 0, activeId: cli?.sessionId });
  };

  const applyModel = async (name) => {
    if (!name) return;
    if (commands?.handle) {
      await runCommand(`/model ${name}`);
      return;
    }
    if (config) config.model = name;
    setModel(name);
    pushSystem(`Model set to ${name}.`);
  };

  const applySession = async (id) => {
    const sess = await agent.loadSession(id);
    if (!sess) return pushSystem(`Session ${id} not found.`, 'error');
    cli.sessionId = sess.id;
    setSessionId(sess.id);
    setItems([]);
    liveAssistantRef.current = null;
    pushSystem(`Resumed session ${sess.id} (${sess.messages.length} messages).`);
  };

  useInput((char, key) => {
    if (permission) {
      if (char.toLowerCase() === 'y') resolvePermission('allow');
      else if (char.toLowerCase() === 'a') resolvePermission('always');
      else if (char.toLowerCase() === 'n' || key.escape) resolvePermission('deny');
      return;
    }
    if (overlay) {
      const length =
        overlay.kind === 'models' ? overlay.models.length : overlay.kind === 'sessions' ? overlay.sessions.length : 0;
      if (key.escape) return setOverlay(null);
      if (key.ctrl && char.toLowerCase() === 'k') return setOverlay(null);
      if (!length) {
        if (key.return) setOverlay(null);
        return;
      }
      if (key.upArrow) return setOverlay((o) => ({ ...o, index: (o.index - 1 + length) % length }));
      if (key.downArrow) return setOverlay((o) => ({ ...o, index: Math.min(o.index + 1, length - 1) }));
      if (key.return) {
        if (overlay.kind === 'models') {
          const chosen = overlay.models[overlay.index];
          setOverlay(null);
          return applyModel(chosen?.id);
        }
        if (overlay.kind === 'sessions') {
          const chosen = overlay.sessions[overlay.index];
          setOverlay(null);
          return applySession(chosen?.id);
        }
      }
      return;
    }
    if (key.ctrl && char === 'c') {
      if (busy) cancelAgent();
      else exit();
      return;
    }
    if (key.escape && busy) return cancelAgent();
    if (key.ctrl && char.toLowerCase() === 'l') return setItems([]);
    if (key.ctrl && char.toLowerCase() === 'p') return setShowPlan((value) => !value);
    if (key.ctrl && char.toLowerCase() === 'r') return setShowReasoning((value) => !value);
    if (key.ctrl && char.toLowerCase() === 'o') return openModels();
    if (key.ctrl && char.toLowerCase() === 's') return openSessions();
    if (key.ctrl && char.toLowerCase() === 'k') return setOverlay((o) => (o?.kind === 'help' ? null : { kind: 'help' }));
    if (key.ctrl || key.meta) return;
    if (key.tab) {
      const palette = paletteMatches(commandItems, input);
      if (input.startsWith('/') && palette.length) {
        const completed = `${palette[paletteIndex % palette.length].name} `;
        setInput(completed);
        setCursor(completed.length);
      } else setExpandedTools((value) => !value);
      return;
    }
    if (key.upArrow && input.startsWith('/')) return setPaletteIndex((i) => Math.max(0, i - 1));
    if (key.downArrow && input.startsWith('/')) return setPaletteIndex((i) => i + 1);
    if (key.return) return submit(input);
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(input.length, c + 1));
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
        setPaletteIndex(0);
      }
      return;
    }
    if (char) {
      setInput(input.slice(0, cursor) + char + input.slice(cursor));
      setCursor(cursor + char.length);
      setPaletteIndex(0);
    }
  });

  const done = items.filter((item) => item.done);
  const live = items.filter((item) => !item.done);
  const maxSteps = config?.maxSteps || 60;
  const hints = permission
    ? 'y allow · a always · n deny'
    : overlay
      ? '↑↓ move · enter select · esc close'
      : busy
        ? 'esc cancel · ctrl+p plan · ctrl+o model'
        : 'enter send · / commands · ctrl+o model · ctrl+s sessions · ctrl+k help';
  const showPalette = !overlay && input.startsWith('/') && commandItems.length > 0;
  const workerUrl = config?.workerUrl || '—';
  const permMode = agent?.permissions?.mode?.() || config?.permissionMode || 'ask';

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Box,
      { flexDirection: 'column', borderStyle: 'single', borderColor: theme.primary, paddingX: 1, marginBottom: 1 },
      h(
        Text,
        null,
        h(Text, { color: theme.primary, bold: true }, moduleName.toUpperCase()),
        h(Text, { color: theme.dim }, `  ·  ${model}  ·  perm ${permMode}  ·  ${oneLine(agent?.cwd || '', Math.max(10, columns() - 40))}`),
      ),
      h(Text, { color: theme.dim }, `worker ${oneLine(workerUrl, columns() - 10)}`),
      h(Text, { color: theme.dim }, `session ${sessionId || '—'}  ·  step ${step}/${maxSteps}`),
    ),
    h(PlanPanel, { todos, step, maxSteps, visible: showPlan, theme }),
    h(Static, { items: done }, (item) => renderItem(item, spin, expandedTools, showReasoning, theme)),
    live.map((item) => renderItem(item, spin, expandedTools, showReasoning, theme)),
    busy ? h(Text, { color: theme.warn }, `  ${spin} ${step ? `working · step ${step}/${maxSteps}` : 'working'}…`) : null,
    h(PermissionPanel, { request: permission, theme }),
    h(Overlay, { overlay, theme }),
    showPalette ? h(CommandPalette, { items: commandItems, filter: input, index: paletteIndex, theme }) : null,
    h(
      Box,
      { marginTop: 1 },
      h(Text, { color: theme.user, bold: true }, '› '),
      permission
        ? h(Text, { color: theme.warn }, 'Choose permission above…')
        : h(InputLine, {
            value: input,
            cursor,
            theme,
            focused: !overlay && !permission,
            placeholder: busy ? '' : 'Ask anything, describe work in plain English, or type / for commands',
          }),
    ),
    h(
      Box,
      { justifyContent: 'space-between' },
      h(Text, { color: theme.dim }, oneLine(`${model} · ${agent?.cwd || ''}`, Math.floor(columns() / 2))),
      h(Text, { color: theme.dim }, oneLine(hints, Math.floor(columns() / 2))),
    ),
  );
}

export function paletteMatches(items, filter) {
  const needle = String(filter).replace(/^\//, '').toLowerCase();
  return items.filter((i) => i.name.slice(1).toLowerCase().startsWith(needle)).slice(0, 8);
}

export async function startTerminal({ cli, agent, client, commands, config, moduleName = 'agent' }) {
  const url = config?.workerUrl || '(not set)';
  process.stdout.write(`\n  \u001b[36m\u001b[1m${moduleName}\u001b[0m \u001b[90m— personal terminal UI\u001b[0m\n`);
  process.stdout.write(`  \u001b[90mworker: ${url}   model: ${config?.model || 'auto'}   tools: ${config?.tools !== false ? 'on' : 'off'}\u001b[0m\n\n`);
  const app = render(h(Terminal, { cli, agent, client, commands, config, moduleName }), { exitOnCtrlC: false });
  await app.waitUntilExit();
}

export { renderItem };
