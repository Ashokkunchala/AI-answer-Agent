import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { renderMarkdown } from './markdown.js';

const h = React.createElement;
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

function stripAnsi(value) { return String(value).replace(ANSI, ''); }
function columns() { return process.stdout.columns || 80; }
function oneLine(value, max) {
  const line = stripAnsi(value).replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}
function shortArgs(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
  try { return oneLine(JSON.stringify(args), Math.max(20, columns() - 14)); } catch { return String(args); }
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

// Render a unified diff (array of { type, text }) with +/- coloring.
function DiffBlock({ diff, theme, expanded }) {
  if (!Array.isArray(diff) || !diff.length) return null;
  const limit = expanded ? diff.length : 12;
  const shown = diff.slice(0, limit);
  return h(
    Text, { color: theme.dim },
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
    Box, { flexDirection: 'column', marginBottom: 0 },
    h(Text, { color }, `  ${item.scope ? `${item.scope} ` : ''}${marker} `, h(Text, { bold: true }, item.name), shortArgs(item.args) ? h(Text, { color: theme.dim }, ` ${shortArgs(item.args)}`) : null),
    !running && hasDiff ? h(DiffBlock, { diff: item.diff, theme, expanded }) : null,
    !running && (lines.length
      ? h(Text, { color: theme.dim }, lines.map((line, index) => `     ${index === 0 ? '⎿ ' : '  '}${oneLine(line, columns() - 8)}`).join('\n'))
      : hasDiff ? null : h(Text, { color: theme.dim }, '     ⎿ (no output)')),
  );
}

function AssistantText({ text, theme }) {
  const nodes = renderMarkdown(text);
  void theme;
  return h(Box, { flexDirection: 'column' }, ...nodes);
}

function renderItem(item, spin, expanded, theme) {
  if (item.role === 'user') return h(Box, { key: item.id }, h(Text, { color: theme.user, bold: true }, '› '), h(Text, null, item.text));
  if (item.role === 'assistant') return h(Box, { key: item.id, flexDirection: 'column', marginBottom: 0 }, h(AssistantText, { text: item.text, theme }));
  if (item.role === 'tool') return h(ToolBlock, { key: item.id, item, spin, expanded, theme });
  if (item.role === 'reasoning') return h(Box, { key: item.id }, h(Text, { color: theme.dim, italic: true }, `  ✻ ${oneLine(item.text, columns() - 6)}`));
  return h(Box, { key: item.id }, h(Text, { color: item.role === 'error' ? theme.error : item.role === 'warning' ? theme.warn : theme.dim }, item.text));
}

function PlanPanel({ todos, step, maxSteps, visible, theme }) {
  if (!visible) return null;
  const rows = todos.length ? todos.map((todo, index) => {
    const marker = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'cancelled' ? '–' : '○';
    const color = todo.status === 'completed' ? theme.ok : todo.status === 'in_progress' ? theme.warn : theme.dim;
    return h(Text, { key: `${todo.content}-${index}`, color }, ` ${marker} ${todo.content}`);
  }) : [h(Text, { key: 'empty', color: theme.dim }, ' No plan yet — multi-step tasks will create one here.')];
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: theme.primary, paddingX: 1, marginBottom: 1 }, h(Text, { color: theme.primary, bold: true }, `WORK PLAN${step ? ` · step ${step}/${maxSteps}` : ''}`), ...rows);
}

function PermissionPanel({ request, theme }) {
  if (!request) return null;
  const preview = request.preview;
  const detail = request.args?.path || request.args?.command || request.args?.url || JSON.stringify(request.args || {});
  const previewLines = preview?.lines ? preview.lines.slice(0, 12) : [];
  return h(
    Box, { flexDirection: 'column', borderStyle: 'double', borderColor: theme.warn, paddingX: 1, marginBottom: 1 },
    h(Text, { color: theme.warn, bold: true }, `Permission required: ${request.name}${request.reason ? ` (${request.reason})` : ''}`),
    preview?.kind === 'diff' ? null : h(Text, { color: theme.dim }, oneLine(detail, columns() - 6)),
    previewLines.length ? h(Text, { color: theme.dim }, previewLines.map((l) => `  ${oneLine(l, columns() - 4)}`).join('\n')) : null,
    h(Text, null, ' y allow  ·  a always allow this tool  ·  n deny'),
  );
}

function CommandPalette({ items, filter, theme }) {
  const matches = items.filter((i) => i.name.slice(1).toLowerCase().startsWith(String(filter).replace(/^\//, '').toLowerCase())).slice(0, 8);
  if (!matches.length) return null;
  return h(
    Box, { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    ...matches.map((i, idx) => h(Text, { key: i.name, color: idx === 0 ? theme.accent : theme.dim }, `${idx === 0 ? '▸ ' : '  '}${i.name.padEnd(14)} ${i.description}`)),
  );
}

function Sidebar({ info, theme, visible }) {
  if (!visible) return null;
  const rows = [
    h(Text, { key: 'h', color: theme.primary, bold: true }, 'WORKSPACE'),
    h(Text, { key: 'w', color: theme.dim }, oneLine(info.cwd, 26)),
    h(Text, { key: 'm', color: theme.dim }, `model ${info.model || 'auto'}`),
    h(Text, { key: 'p', color: theme.dim }, `perm ${info.permission || 'ask'}`),
    h(Text, { key: 't', color: theme.dim }, `${info.toolCount ?? 0} tools · ${info.skillCount ?? 0} skills`),
    info.checkpoints ? h(Text, { key: 'c', color: theme.dim }, `${info.checkpoints} checkpoint(s)`) : null,
  ].filter(Boolean);
  if (info.sessions?.length) {
    rows.push(h(Text, { key: 'sh', color: theme.primary, bold: true }, 'RECENT SESSIONS'));
    for (const s of info.sessions.slice(0, 6)) rows.push(h(Text, { key: s.id, color: s.id === info.sessionId ? theme.ok : theme.dim }, oneLine(` ${s.title || s.id}`, 26)));
  }
  return h(Box, { flexDirection: 'column', width: 28, borderStyle: 'single', borderColor: theme.dim, paddingX: 1, marginRight: 1 }, ...rows);
}

export function App({ cli, agent, commands, config }) {
  const { exit } = useApp();
  const theme = resolveTheme(config?.theme);
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState([]);
  const [step, setStep] = useState(0);
  const [showPlan, setShowPlan] = useState(true);
  const [showSidebar, setShowSidebar] = useState(false);
  const [expandedTools, setExpandedTools] = useState(false);
  const [permission, setPermission] = useState(null);
  const [commandItems, setCommandItems] = useState([]);
  const [sidebarInfo, setSidebarInfo] = useState({ cwd: agent?.cwd, model: config?.model, permission: config?.permissionMode || 'ask' });
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
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [commands]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const info = { cwd: agent?.cwd, sessionId: cli?.sessionId, model: config?.model, permission: agent?.permissions?.mode?.() || config?.permissionMode || 'ask' };
      try {
        info.toolCount = agent?.registry?.list?.().length;
        info.skillCount = (await agent?.skills?.list?.())?.length;
        info.checkpoints = (await agent?.checkpoints?.list?.(cli?.sessionId))?.length;
        info.sessions = await cli?.sessionStore?.list?.();
      } catch { /* ignore */ }
      if (alive) setSidebarInfo(info);
    })();
    return () => { alive = false; };
  }, [agent, cli, config, showSidebar, todos]);

  const push = (item) => setItems((previous) => [...previous, item]);
  const pushSystem = (text, role = 'system') => push({ id: `s${++idRef.current}`, role, text, done: true });
  const finalizeTurn = () => {
    const assistantId = liveAssistantRef.current;
    liveAssistantRef.current = null;
    setItems((previous) => previous.map((item) => {
      if (item.id === assistantId) return { ...item, done: true };
      if (item.role === 'tool' && item.status === 'running') return { ...item, status: 'done', done: true };
      return item;
    }));
  };
  const onEvent = (event) => {
    const scope = event.scope;
    if (event.type === 'content') {
      let id = liveAssistantRef.current;
      if (!id) {
        id = `a${++idRef.current}`;
        liveAssistantRef.current = id;
        setItems((previous) => [...previous, { id, role: 'assistant', text: event.text, done: false, scope }]);
      } else setItems((previous) => previous.map((item) => item.id === id ? { ...item, text: item.text + event.text } : item));
    } else if (event.type === 'reasoning') {
      push({ id: `r${++idRef.current}`, role: 'reasoning', text: event.text, done: true, scope });
    } else if (event.type === 'tool_start') {
      const assistantId = liveAssistantRef.current;
      liveAssistantRef.current = null;
      const id = `t${++idRef.current}`;
      setItems((previous) => [...previous.map((item) => item.id === assistantId ? { ...item, done: true } : item), { id, role: 'tool', name: event.name, args: event.args, status: 'running', done: false, scope }]);
    } else if (event.type === 'tool_end') {
      setItems((previous) => {
        const index = previous.map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name && item.scope === scope).lastIndexOf(true);
        const fallback = index < 0 ? previous.map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name).lastIndexOf(true) : index;
        if (fallback < 0) return previous;
        const output = event.result?.output || '';
        const next = previous.slice();
        next[fallback] = { ...next[fallback], status: event.result?.metadata?.error || /^Error\b/.test(output) ? 'error' : 'done', output, diff: event.result?.metadata?.diff, done: true };
        return next;
      });
    } else if (event.type === 'todos') setTodos(event.todos || []);
    else if (event.type === 'step') setStep(event.current || 0);
    else if (event.type === 'warning') pushSystem(event.text, 'warning');
    else if (event.type === 'error') pushSystem(event.text, 'error');
    else if (event.type === 'checkpoint') pushSystem(`checkpoint ${event.checkpoint?.id} saved (${event.checkpoint?.label})`);
    else if (event.type === 'subagent_start') pushSystem(`↳ ${event.subagentType || 'subagent'}: ${event.description || ''}`);
    else if (event.type === 'subagent_end') pushSystem(`↳ ${event.subagentType || 'subagent'} finished`);
  };
  const requestPermission = (request) => new Promise((resolve) => { permissionResolveRef.current = resolve; setPermission(request); });
  const resolvePermission = (decision) => { const resolve = permissionResolveRef.current; permissionResolveRef.current = null; setPermission(null); resolve?.(decision); };
  const cancelAgent = () => { if (agent?.cancel) agent.cancel(); else if (agent) agent.cancelled = true; };
  const runCommand = async (line) => {
    if (line === '/exit' || line === '/quit') return exit();
    const original = { log: console.log, error: console.error };
    const logs = [];
    const sink = (...args) => logs.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
    console.log = sink; console.error = sink; setBusy(true);
    let result;
    try { result = await commands.handle(line); } catch (error) { logs.push(`Error: ${error.message}`); } finally { console.log = original.log; console.error = original.error; setBusy(false); }
    if (result === 'exit') return exit();
    if (logs.length) pushSystem(logs.map(stripAnsi).join('\n'));
    if (result && typeof result === 'object' && result.prompt) await runPrompt(result.prompt);
  };
  const runPrompt = async (line) => {
    push({ id: `u${++idRef.current}`, role: 'user', text: line, done: true });
    setBusy(true); setStep(0);
    try { await agent.chat({ message: line, sessionId: cli.sessionId, onEvent, onPermission: requestPermission }); }
    catch (error) { pushSystem(`Error: ${error.message}`, 'error'); }
    finally { finalizeTurn(); setStep(0); setBusy(false); }
  };
  const submit = async (value) => {
    const line = value.trim(); setInput('');
    if (!line || permission) return;
    if (busy) return pushSystem('Still working — press Esc to cancel the current turn.');
    if (line.startsWith('/')) return runCommand(line);
    await runPrompt(line);
  };
  useInput((char, key) => {
    if (permission) {
      if (char.toLowerCase() === 'y') resolvePermission('allow');
      else if (char.toLowerCase() === 'a') resolvePermission('always');
      else if (char.toLowerCase() === 'n' || key.escape) resolvePermission('deny');
      return;
    }
    if (key.ctrl && char === 'c') { if (busy) cancelAgent(); else exit(); }
    else if (key.escape && busy) cancelAgent();
    else if (key.ctrl && char.toLowerCase() === 'l') setItems([]);
    else if (key.ctrl && char.toLowerCase() === 'p') setShowPlan((value) => !value);
    else if (key.ctrl && char.toLowerCase() === 'b') setShowSidebar((value) => !value);
    else if (key.tab) setExpandedTools((value) => !value);
  });
  const done = items.filter((item) => item.done);
  const live = items.filter((item) => !item.done);
  const maxSteps = config?.maxSteps || 60;
  const hints = permission ? 'y allow · a always · n deny' : busy ? 'esc cancel · ctrl+p plan · ctrl+b sidebar' : 'enter send · tab output · ctrl+p plan · ctrl+b sidebar · ctrl+l clear';
  const showPalette = input.startsWith('/') && commandItems.length > 0;
  return h(
    Box, { flexDirection: 'row' },
    h(Sidebar, { info: { ...sidebarInfo, model: config?.model, cwd: agent?.cwd, sessionId: cli?.sessionId }, theme, visible: showSidebar }),
    h(
      Box, { flexDirection: 'column', flexGrow: 1 },
      h(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: theme.primary, paddingX: 1, marginBottom: 1 }, h(Text, { color: theme.primary, bold: true }, 'AGENT WORKBENCH'), h(Text, { color: theme.dim }, `${config?.model || 'auto'} · tools ${config?.tools !== false ? 'on' : 'off'} · ${agent?.cwd}`)),
      h(PlanPanel, { todos, step, maxSteps, visible: showPlan, theme }),
      h(Static, { items: done }, (item) => renderItem(item, spin, expandedTools, theme)),
      live.map((item) => renderItem(item, spin, expandedTools, theme)),
      busy ? h(Text, { color: theme.warn }, `  ${spin} ${step ? `working · step ${step}/${maxSteps}` : 'working'}…`) : null,
      h(PermissionPanel, { request: permission, theme }),
      showPalette ? h(CommandPalette, { items: commandItems, filter: input, theme }) : null,
      h(Box, { marginTop: 1 }, h(Text, { color: theme.user, bold: true }, '› '), permission ? h(Text, { color: theme.warn }, 'Choose permission above…') : h(TextInput, { value: input, onChange: setInput, onSubmit: submit, placeholder: busy ? '' : 'Ask anything — describe the work in plain English, or type / for a command' })),
      h(Box, { justifyContent: 'space-between' }, h(Text, { color: theme.dim }, oneLine(`${config?.model || 'auto'} · ${agent?.cwd}`, Math.floor(columns() / 2))), h(Text, { color: theme.dim }, hints)),
    ),
  );
}

export async function startTui({ cli, agent, client, commands, config }) {
  const url = config?.workerUrl || '(not set)';
  process.stdout.write(`\n  \u001b[36m\u001b[1magent\u001b[0m \u001b[90m— local coding agent\u001b[0m\n`);
  process.stdout.write(`  \u001b[90mworker: ${url}   model: ${config?.model || 'auto'}   tools: ${config?.tools !== false ? 'on' : 'off'}\u001b[0m\n\n`);
  const app = render(h(App, { cli, agent, client, commands, config }), { exitOnCtrlC: false });
  await app.waitUntilExit();
}

export { stripAnsi, oneLine, shortArgs };
