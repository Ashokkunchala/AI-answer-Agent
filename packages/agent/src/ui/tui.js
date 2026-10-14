import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';

const h = React.createElement;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

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

function ToolBlock({ item, spin, expanded }) {
  const running = item.status === 'running';
  const failed = item.status === 'error';
  const color = failed ? 'red' : running ? 'yellow' : 'cyan';
  const marker = running ? spin : failed ? '✗' : '⏺';
  const lines = stripAnsi(item.output || '').split('\n').filter((line, index, all) => line.length || index < all.length - 1).slice(0, expanded ? 40 : 6);
  return h(
    Box, { flexDirection: 'column', marginBottom: 0 },
    h(Text, { color }, `  ${marker} `, h(Text, { bold: true }, item.name), shortArgs(item.args) ? h(Text, { color: 'gray' }, ` ${shortArgs(item.args)}`) : null),
    !running && (lines.length
      ? h(Text, { color: 'gray' }, lines.map((line, index) => `     ${index === 0 ? '⎿ ' : '  '}${oneLine(line, columns() - 8)}`).join('\n'))
      : h(Text, { color: 'gray' }, '     ⎿ (no output)')),
  );
}

function renderItem(item, spin, expanded) {
  if (item.role === 'user') return h(Box, { key: item.id }, h(Text, { color: 'green', bold: true }, '› '), h(Text, null, item.text));
  if (item.role === 'assistant') return h(Box, { key: item.id }, h(Text, null, item.text));
  if (item.role === 'tool') return h(ToolBlock, { key: item.id, item, spin, expanded });
  return h(Box, { key: item.id }, h(Text, { color: item.role === 'error' ? 'red' : 'gray' }, item.text));
}

function PlanPanel({ todos, step, maxSteps, visible }) {
  if (!visible) return null;
  const rows = todos.length ? todos.map((todo, index) => {
    const marker = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'cancelled' ? '–' : '○';
    const color = todo.status === 'completed' ? 'green' : todo.status === 'in_progress' ? 'yellow' : 'gray';
    return h(Text, { key: `${todo.content}-${index}`, color }, ` ${marker} ${todo.content}`);
  }) : [h(Text, { key: 'empty', color: 'gray' }, ' No plan yet — multi-step tasks will create one here.')];
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, marginBottom: 1 }, h(Text, { color: 'cyan', bold: true }, `WORK PLAN${step ? ` · step ${step}/${maxSteps}` : ''}`), ...rows);
}

function PermissionPanel({ request }) {
  if (!request) return null;
  const detail = request.args?.path || request.args?.command || request.args?.url || JSON.stringify(request.args || {});
  return h(
    Box, { flexDirection: 'column', borderStyle: 'double', borderColor: 'yellow', paddingX: 1, marginBottom: 1 },
    h(Text, { color: 'yellow', bold: true }, `Permission required: ${request.name}`),
    h(Text, { color: 'gray' }, oneLine(detail, columns() - 6)),
    h(Text, null, ' y allow  ·  a always allow this tool  ·  n deny'),
  );
}

export function App({ cli, agent, commands, config }) {
  const { exit } = useApp();
  const [items, setItems] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState([]);
  const [step, setStep] = useState(0);
  const [showPlan, setShowPlan] = useState(true);
  const [expandedTools, setExpandedTools] = useState(false);
  const [permission, setPermission] = useState(null);
  const idRef = useRef(0);
  const liveAssistantRef = useRef(null);
  const permissionResolveRef = useRef(null);
  const spin = useSpinner(busy);

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
    if (event.type === 'content') {
      let id = liveAssistantRef.current;
      if (!id) {
        id = `a${++idRef.current}`;
        liveAssistantRef.current = id;
        setItems((previous) => [...previous, { id, role: 'assistant', text: event.text, done: false }]);
      } else setItems((previous) => previous.map((item) => item.id === id ? { ...item, text: item.text + event.text } : item));
    } else if (event.type === 'tool_start') {
      const assistantId = liveAssistantRef.current;
      liveAssistantRef.current = null;
      const id = `t${++idRef.current}`;
      setItems((previous) => [...previous.map((item) => item.id === assistantId ? { ...item, done: true } : item), { id, role: 'tool', name: event.name, args: event.args, status: 'running', done: false }]);
    } else if (event.type === 'tool_end') {
      setItems((previous) => {
        const index = previous.map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name).lastIndexOf(true);
        if (index < 0) return previous;
        const output = event.result?.output || '';
        const next = previous.slice();
        next[index] = { ...next[index], status: event.result?.metadata?.error || /^Error\b/.test(output) ? 'error' : 'done', output, done: true };
        return next;
      });
    } else if (event.type === 'todos') setTodos(event.todos || []);
    else if (event.type === 'step') setStep(event.current || 0);
  };
  const requestPermission = (request) => new Promise((resolve) => { permissionResolveRef.current = resolve; setPermission(request); });
  const resolvePermission = (decision) => { const resolve = permissionResolveRef.current; permissionResolveRef.current = null; setPermission(null); resolve?.(decision); };
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
  };
  const submit = async (value) => {
    const line = value.trim(); setInput('');
    if (!line || permission) return;
    if (busy) return pushSystem('Still working — press Esc to cancel the current turn.');
    if (line.startsWith('/')) return runCommand(line);
    push({ id: `u${++idRef.current}`, role: 'user', text: line, done: true });
    setBusy(true); setStep(0);
    try { await agent.chat({ message: line, sessionId: cli.sessionId, onEvent, onPermission: requestPermission }); }
    catch (error) { pushSystem(`Error: ${error.message}`, 'error'); }
    finally { finalizeTurn(); setStep(0); setBusy(false); }
  };
  useInput((char, key) => {
    if (permission) {
      if (char.toLowerCase() === 'y') resolvePermission('allow');
      else if (char.toLowerCase() === 'a') resolvePermission('always');
      else if (char.toLowerCase() === 'n' || key.escape) resolvePermission('deny');
      return;
    }
    if (key.ctrl && char === 'c') { if (busy) agent.cancelled = true; else exit(); }
    else if (key.escape && busy) agent.cancelled = true;
    else if (key.ctrl && char.toLowerCase() === 'l') setItems([]);
    else if (key.ctrl && char.toLowerCase() === 'p') setShowPlan((value) => !value);
    else if (key.tab) setExpandedTools((value) => !value);
  });
  const done = items.filter((item) => item.done);
  const live = items.filter((item) => !item.done);
  const maxSteps = config.maxSteps || 60;
  const hints = permission ? 'y allow · a always · n deny' : busy ? 'esc cancel · ctrl+p plan' : 'enter send · tab output · ctrl+p plan · ctrl+l clear';
  return h(
    Box, { flexDirection: 'column' },
    h(Box, { flexDirection: 'column', borderStyle: 'single', borderColor: 'cyan', paddingX: 1, marginBottom: 1 }, h(Text, { color: 'cyan', bold: true }, 'AGENT WORKBENCH'), h(Text, { color: 'gray' }, `${config.model || 'auto'} · tools ${config.tools !== false ? 'on' : 'off'} · ${agent.cwd}`)),
    h(PlanPanel, { todos, step, maxSteps, visible: showPlan }),
    h(Static, { items: done }, (item) => renderItem(item, spin, expandedTools)),
    live.map((item) => renderItem(item, spin, expandedTools)),
    busy ? h(Text, { color: 'yellow' }, `  ${spin} ${step ? `working · step ${step}/${maxSteps}` : 'working'}…`) : null,
    h(PermissionPanel, { request: permission }),
    h(Box, { marginTop: 1 }, h(Text, { color: 'green', bold: true }, '› '), permission ? h(Text, { color: 'yellow' }, 'Choose permission above…') : h(TextInput, { value: input, onChange: setInput, onSubmit: submit, placeholder: busy ? '' : 'Ask anything — describe the work in plain English, or type / for a command' })),
    h(Box, { justifyContent: 'space-between' }, h(Text, { color: 'gray' }, oneLine(`${config.model || 'auto'} · ${agent.cwd}`, Math.floor(columns() / 2))), h(Text, { color: 'gray' }, hints)),
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
