import React, { useEffect, useMemo, useRef, useState } from 'react';
import { render, Box, Text, Static, useApp, useInput } from 'ink';
import { renderMarkdown } from './markdown.js';
import { EVENT } from '../core/events.js';

const h = React.createElement;

// ── NEO terminal ────────────────────────────────────────────────────────────
// Agent's full-screen front end for the in-process agent core.
//
// Abilities beyond the classic terminal:
//   * live token streaming (content/reasoning deltas as they arrive)
//   * `! <command>` shell passthrough (runs the bash tool directly)
//   * prompt history (↑ / ↓), /history, /retry (re-run the last turn)
//   * overlay pickers: models (ctrl+o), sessions (ctrl+s), tools (ctrl+t),
//     help (ctrl+k) — each arrow-key navigable
//   * command palette with tab-completion for every slash command
//   * multi-line input (alt+enter / ctrl+j), cursor editing, ctrl+a/e/u/w
//   * permission prompts with colored diff previews (y / a / n)
//   * plan panel, reasoning toggle, per-turn step counter, worker health dot
//
// It talks to the same `{ cli, agent, client, commands, config }` objects the
// CLI wires up, so any host can embed it.

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
const INPUT_MAX_LINES = 10;

const THEMES = {
  dark: { primary: 'cyan', dim: 'gray', accent: 'magenta', ok: 'green', warn: 'yellow', error: 'red', user: 'green' },
  light: { primary: 'blue', dim: 'gray', accent: 'magenta', ok: 'green', warn: 'yellow', error: 'red', user: 'blue' },
  mono: { primary: 'white', dim: 'gray', accent: 'white', ok: 'white', warn: 'white', error: 'white', user: 'white' },
};

const HELP_ROWS = [
  ['enter', 'send message'],
  ['alt+enter / ctrl+j', 'insert a newline'],
  ['esc', 'cancel the current turn / close overlay'],
  ['ctrl+c', 'cancel turn, quit when idle'],
  ['! <cmd>', 'run a shell command directly'],
  ['tab', 'complete command / expand tool output'],
  ['↑ / ↓', 'prompt history (or palette navigation)'],
  ['ctrl+p', 'toggle the work plan panel'],
  ['ctrl+r', 'toggle reasoning display'],
  ['ctrl+o', 'pick a model'],
  ['ctrl+s', 'switch / resume session'],
  ['ctrl+t', 'inspect available tools'],
  ['ctrl+k', 'toggle this help'],
  ['ctrl+l', 'clear the transcript'],
  ['ctrl+a / ctrl+e', 'start / end of line'],
  ['ctrl+u / ctrl+w', 'cut line / cut word'],
  ['/retry', 're-run the last message'],
  ['/history', 'show recent prompts'],
  ['/help', 'list every slash command'],
];

const PSEUDO_COMMANDS = [
  { name: '/retry', description: 'Re-run the last message from scratch' },
  { name: '/history', description: 'Show recent prompts' },
];

export function resolveTheme(name) {
  if (name === 'light') return THEMES.light;
  if (name === 'mono') return THEMES.mono;
  return THEMES.dark;
}

export function stripAnsi(value) {
  return String(value).replace(ANSI, '');
}

function columns() {
  return process.stdout.columns || 100;
}

export function oneLine(value, max) {
  const line = stripAnsi(value).replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, Math.max(0, max - 1))}…`;
}

function shortArgs(args) {
  if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';
  try {
    return oneLine(JSON.stringify(args), Math.max(20, columns() - 20));
  } catch (e) {
    console.debug?.(`Failed to stringify args: ${e.message}`);
    return String(args);
  }
}

function shortId(value) {
  return String(value || '').replace(/-/g, '').slice(0, 8) || '—';
}

// ── Live activity (opencode-style "what is the backend doing right now") ────
// Pure so it can be unit tested; the component recomputes it on every spinner
// frame (80ms) which keeps the elapsed timer and char count live.
const ACTIVITY_LABELS = {
  working: 'working',
  thinking: 'thinking',
  reasoning: 'reasoning',
  streaming: 'replying',
  args: 'assembling tool call',
  tool: 'tool',
  check: 'running check',
  subagent: 'sub-agent',
};

export function activityLine({ activity, spin = '*', activeModel = '', chars = 0, now = Date.now() } = {}) {
  const kind = activity?.kind || 'working';
  const label = ACTIVITY_LABELS[kind] || 'working';
  const detail = activity?.detail ? oneLine(String(activity.detail), 60) : '';
  const parts = [];
  if (detail) parts.push(detail);
  if (kind === 'streaming') parts.push(`${chars} chars`);
  const since = Number(activity?.since) || now;
  parts.push(`${Math.max(0, (now - since) / 1000).toFixed(1)}s`);
  if (activeModel) parts.push(`via ${activeModel}`);
  return `  ${spin} ${label} · ${parts.join(' · ')}`;
}

export function activityPhaseColor(kind, theme) {
  if (kind === 'streaming') return theme.ok;
  if (kind === 'tool' || kind === 'args' || kind === 'check') return theme.warn;
  if (kind === 'subagent') return theme.accent;
  return theme.primary;
}

function useSpinner(active) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setFrame((value) => value + 1), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER[frame % SPINNER.length];
}

function paletteMatches(items, filter) {
  const needle = String(filter).replace(/^\//, '').toLowerCase();
  if (!needle) return items.slice(0, 8);
  const prefix = items.filter((i) => i.name.slice(1).toLowerCase().startsWith(needle));
  const contains = items.filter(
    (i) => !prefix.includes(i) && i.name.slice(1).toLowerCase().includes(needle),
  );
  return [...prefix, ...contains].slice(0, 8);
}

export { paletteMatches };

// ── Cost-aware model ordering (mirrors the worker's budget planner) ─────────
// Free neuron-pool models first, then cheapest token models, then unit-priced,
// then gateway/external last — so the picker leads with the cheapest options.

export function modelCostRank(model) {
  const p = model?.pricing || {};
  if (p.pool) return 0;
  if (typeof p.in === 'number') return Math.max((p.in + (typeof p.out === 'number' ? p.out : p.in)) / 2, 0.0001);
  if (p.per || p.usd !== undefined) return Math.max(Number(p.usd) || 0, 0.0001) * 1000;
  return 1e9;
}

export function modelPriceTag(model) {
  const p = model?.pricing || {};
  if (model?.auto) return 'router';
  if (p.pool) return 'free';
  if (typeof p.in === 'number') {
    const avg = (p.in + (typeof p.out === 'number' ? p.out : p.in)) / 2;
    return `$${avg < 0.1 ? avg.toFixed(3) : avg.toFixed(2)}/M`;
  }
  if (p.per) return `$${p.usd ?? 0}/unit`;
  if (p.note) return 'gateway';
  return '';
}

export function orderModelsForPicker(models, { autoAllowed = true } = {}) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && m.id !== 'auto');
  const sorted = [...list].sort(
    (a, b) => modelCostRank(a) - modelCostRank(b) || String(a.id).localeCompare(String(b.id)),
  );
  return autoAllowed
    ? [{ id: 'auto', name: 'Auto — provider routing', auto: true }, ...sorted]
    : sorted;
}

export function compactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function budgetSummary(budget) {
  if (!budget) return '';
  const free = `${compactTokens(budget.free_remaining)}/${compactTokens(budget.free_neurons_per_day)}`;
  const mode = budget.mode && budget.mode !== 'free' ? ` · ${budget.mode}` : '';
  const spend = Number.isFinite(budget.usd_month) && budget.budget_monthly_usd
    ? ` · $${budget.usd_month.toFixed(budget.usd_month >= 1 ? 2 : 4)}/${budget.budget_monthly_usd}`
    : '';
  return `free ${free}${mode}${spend}`;
}

// Per-turn summary line (opencode-style): latency, tokens, the model the worker
// actually routed to, and why. Returns '' when there is nothing to report.
export function formatTurnSummary(turn = {}) {
  const parts = [];
  const seconds = Number(turn.latency_ms);
  if (Number.isFinite(seconds) && seconds > 0) parts.push(`${(seconds / 1000).toFixed(seconds >= 10000 ? 0 : 1)}s`);
  const total = Number(turn.usage?.total_tokens);
  if (Number.isFinite(total) && total > 0) parts.push(`${compactTokens(total)} tok`);
  const model = turn.model || '';
  if (model) parts.push(model);
  const reason = turn.routing?.reason ? oneLine(String(turn.routing.reason), 48) : '';
  if (reason) parts.push(reason);
  return parts.length ? `⏺ ${parts.join(' · ')}` : '';
}

// ── Transcript ──────────────────────────────────────────────────────────────

function DiffBlock({ diff, theme, expanded }) {
  if (!Array.isArray(diff) || !diff.length) return null;
  const limit = expanded ? diff.length : 10;
  const shown = diff.slice(0, limit);
  const hidden = diff.length - shown.length;
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      null,
      ...shown.flatMap((line, index) => {
        const text = oneLine(line.text, columns() - 14);
        const key = `d${index}`;
        if (line.type === 'add') return [h(Text, { key, color: theme.ok }, `       + ${text}\n`)];
        if (line.type === 'del') return [h(Text, { key, color: theme.error }, `       - ${text}\n`)];
        return [h(Text, { key, color: theme.dim }, `         ${text}\n`)];
      }),
    ),
    hidden > 0 ? h(Text, { color: theme.dim }, `         … ${hidden} more line(s) — press tab to expand`) : null,
  );
}

function ToolBlock({ item, spin, expanded, theme }) {
  const running = item.status === 'running';
  const failed = item.status === 'error';
  const color = failed ? theme.error : running ? theme.warn : theme.primary;
  const marker = running ? spin : failed ? '✗' : '⏺';
  const rawLines = stripAnsi(item.output || '')
    .split('\n')
    .filter((line, index, all) => line.length || index < all.length - 1);
  const lines = rawLines.slice(0, expanded ? 60 : 5);
  const hidden = rawLines.length - lines.length;
  const hasDiff = Array.isArray(item.diff) && item.diff.length;
  // Live-tick the elapsed time while a tool is still running (the parent
  // re-renders on every spinner frame).
  const elapsedMs =
    item.durationMs != null ? item.durationMs : running && item.startedAt ? Date.now() - item.startedAt : null;
  const elapsed = elapsedMs != null ? ` ${(elapsedMs / 1000).toFixed(1)}s` : '';

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { color },
      `  ${item.scope ? `${item.scope} ` : ''}${marker} `,
      h(Text, { bold: true }, item.name),
      shortArgs(item.args) ? h(Text, { color: theme.dim }, ` ${shortArgs(item.args)}`) : null,
      elapsed ? h(Text, { color: theme.dim }, elapsed) : null,
    ),
    !running && hasDiff ? h(DiffBlock, { diff: item.diff, theme, expanded }) : null,
    !running
      ? lines.length
        ? h(
            Text,
            { color: theme.dim },
            lines
              .map((line, index) => `     ${index === 0 ? '⎿ ' : '  '}${oneLine(line, columns() - 10)}`)
              .join('\n'),
          )
        : hasDiff
          ? null
          : h(Text, { color: theme.dim }, '     ⎿ (no output)')
      : null,
    !running && hidden > 0
      ? h(Text, { color: theme.dim }, `     ⎿ … ${hidden} more line(s) — press tab`)
      : null,
  );
}

function AssistantText({ text }) {
  const nodes = renderMarkdown(text);
  return h(Box, { flexDirection: 'column' }, ...nodes);
}

function renderItem(item, spin, expanded, showReasoning, theme) {
  if (item.role === 'user') {
    return h(
      Box,
      { key: item.id, flexDirection: 'column' },
      h(
        Text,
        null,
        h(Text, { color: theme.user, bold: true }, item.shell ? '!' : '› '),
        h(Text, { bold: !item.shell, dim: item.shell }, item.text),
      ),
    );
  }
  if (item.role === 'assistant') {
    return h(Box, { key: item.id, flexDirection: 'column' }, h(AssistantText, { text: item.text }));
  }
  if (item.role === 'tool') return h(ToolBlock, { key: item.id, item, spin, expanded, theme });
  if (item.role === 'reasoning') {
    if (!showReasoning) return null;
    return h(
      Box,
      { key: item.id },
      h(Text, { color: theme.dim, italic: true }, `  ✻ ${oneLine(item.text, columns() - 8)}`),
    );
  }
  return h(
    Box,
    { key: item.id, flexDirection: 'column' },
    h(
      Text,
      { color: item.role === 'error' ? theme.error : item.role === 'warning' ? theme.warn : theme.dim },
      item.text.split('\n').map((line, index) => `  ${index === 0 ? '' : '  '}${line}`).join('\n'),
    ),
  );
}

// ── Panels ──────────────────────────────────────────────────────────────────

function PlanPanel({ todos, step, maxSteps, visible, compact, theme }) {
  if (!visible || !todos.length) return null;
  const limit = compact ? 3 : 6;
  const rows = todos.slice(0, limit).map((todo, index) => {
    const marker =
      todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '●' : todo.status === 'cancelled' ? '–' : '○';
    const color = todo.status === 'completed' ? theme.ok : todo.status === 'in_progress' ? theme.warn : theme.dim;
    return h(
      Text,
      { key: `${index}-${todo.content}`, color },
      ` ${marker} ${oneLine(todo.content, columns() - 8)}`,
    );
  });
  const doneCount = todos.filter((t) => t.status === 'completed').length;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.primary, paddingX: 1, marginBottom: 1 },
    h(
      Text,
      null,
      h(Text, { color: theme.primary, bold: true }, ' PLAN '),
      h(Text, { color: theme.dim }, `${doneCount}/${todos.length} done${step ? ` · step ${step}/${maxSteps}` : ''}`),
    ),
    ...rows,
    todos.length > limit ? h(Text, { key: 'more', color: theme.dim }, `  + ${todos.length - limit} more · Ctrl+P to hide the plan`) : null,
  );
}

function PreviewLines({ preview, theme }) {
  const lines = preview?.lines?.slice(0, 14) || [];
  if (!lines.length) return null;
  return h(
    Text,
    null,
    ...lines.flatMap((raw, index) => {
      const text = oneLine(raw, columns() - 8);
      const key = `p${index}`;
      if (preview.kind === 'diff') {
        if (text.startsWith('+')) return [h(Text, { key, color: theme.ok }, `  ${text}\n`)];
        if (text.startsWith('-')) return [h(Text, { key, color: theme.error }, `  ${text}\n`)];
      }
      return [h(Text, { key, color: theme.dim }, `  ${text}\n`)];
    }),
  );
}

function PermissionPanel({ request, theme }) {
  if (!request) return null;
  const detail =
    request.args?.path || request.args?.command || request.args?.url || JSON.stringify(request.args || {});
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.warn, paddingX: 1, marginBottom: 1 },
    h(
      Text,
      { color: theme.warn, bold: true },
      ` ⚠ permission · ${request.name}${request.reason ? ` (${request.reason})` : ''}`,
    ),
    request.preview?.kind === 'diff'
      ? h(PreviewLines, { preview: request.preview, theme })
      : h(Text, { color: theme.dim }, oneLine(detail, columns() - 8)),
    h(Text, null, h(Text, { color: theme.ok }, ' y allow'), '  ·  ', h(Text, { color: theme.warn }, ' a always allow'), '  ·  ', h(Text, { color: theme.error }, ' n deny')),
  );
}

function CommandPalette({ items, filter, index, theme }) {
  const matches = paletteMatches(items, filter);
  if (!matches.length) return null;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    ...matches.map((item, idx) =>
      h(
        Text,
        { key: item.name, color: idx === index ? theme.accent : theme.dim },
        `${idx === index ? '▸ ' : '  '}${item.name.padEnd(14)} ${oneLine(item.description, Math.max(10, columns() - 22))}`,
      ),
    ),
  );
}

function overlayLength(overlay) {
  if (!overlay) return 0;
  if (overlay.kind === 'models') return overlay.models.length;
  if (overlay.kind === 'sessions') return overlay.sessions.length;
  if (overlay.kind === 'tools') return overlay.tools.length;
  return 0;
}

function Overlay({ overlay, theme }) {
  if (!overlay) return null;
  let title = '';
  let rows = [];
  let footer = ' ↑↓ move · enter select · esc close';

  if (overlay.kind === 'models') {
    title = ' Select model · free-tier first ';
    rows = overlay.loading
      ? [h(Text, { key: 'l', color: theme.dim }, '  loading models…')]
      : overlay.models.length
        ? overlay.models.map((m, idx) =>
            h(
              Text,
              { key: `${m.id}${idx}`, color: idx === overlay.index ? theme.accent : theme.dim },
              `${idx === overlay.index ? '▸ ' : '  '}${String(m.id).padEnd(28)} ${modelPriceTag(m).padEnd(9)} ${oneLine(m.name || '', Math.max(8, columns() - 50))}`,
            ),
          )
        : [h(Text, { key: 'e', color: theme.error }, '  no models returned (is the worker reachable?)')];
  } else if (overlay.kind === 'sessions') {
    title = ' Sessions ';
    rows = overlay.sessions.length
      ? overlay.sessions.map((s, idx) =>
          h(
            Text,
            { key: s.id, color: idx === overlay.index ? theme.accent : s.id === overlay.activeId ? theme.ok : theme.dim },
            `${idx === overlay.index ? '▸ ' : '  '}${oneLine(s.title || s.id, 38).padEnd(40)} ${String(s.updatedAt || '').slice(0, 19)}`,
          ),
        )
      : [h(Text, { key: 'e', color: theme.dim }, '  no saved sessions yet')];
  } else if (overlay.kind === 'tools') {
    title = ` Tools (${overlay.tools.length}) `;
    rows = overlay.tools.map((t, idx) =>
      h(
        Box,
        { key: t.name, flexDirection: 'row' },
        h(
          Text,
          { color: idx === overlay.index ? theme.accent : theme.dim },
          `${idx === overlay.index ? '▸ ' : '  '}${String(t.name).padEnd(12)}`,
        ),
        h(Text, { color: theme.dim }, oneLine(`${t.category || ''}${t.mutating ? ' · mutating' : ''}`, 24).padEnd(26)),
        h(Text, { color: idx === overlay.index ? theme.primary : theme.dim }, oneLine(t.description || '', Math.max(10, columns() - 48))),
      ),
    );
    footer = ' ↑↓ move · esc close';
  } else if (overlay.kind === 'help') {
    title = ' Help · keyboard ';
    rows = HELP_ROWS.map(([key, desc], idx) =>
      h(
        Text,
        { key: `h${idx}`, color: theme.dim },
        `  ${String(key).padEnd(20)} ${desc}`,
      ),
    );
    footer = ' ctrl+k / esc to close';
  }

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: theme.accent, paddingX: 1, marginBottom: 1 },
    h(Text, { color: theme.accent, bold: true }, title),
    ...rows.slice(0, 16),
    h(Text, { color: theme.dim }, ` ${footer}`),
  );
}

// ── Input editor ────────────────────────────────────────────────────────────
// Owns the cursor so Ctrl shortcuts never corrupt the line (Ink's text input
// inserts the bare letter for Ctrl combos). Supports multi-line values.

function InputEditor({ value, cursor, theme, focused, placeholder }) {
  if (!focused) {
    return h(
      Text,
      null,
      value ? oneLine(value, columns() - 6) : h(Text, { color: theme.dim }, placeholder),
    );
  }

  if (!value) {
    return h(
      Text,
      null,
      h(Text, { inverse: true, color: theme.dim }, placeholder[0]),
      h(Text, { color: theme.dim }, placeholder.slice(1)),
    );
  }

  const lines = value.split('\n');
  let offset = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    if (cursor <= offset + lines[i].length) {
      cursorLine = i;
      cursorCol = cursor - offset;
      break;
    }
    offset += lines[i].length + 1;
    cursorLine = i;
    cursorCol = lines[i].length;
  }

  const start = Math.max(0, Math.min(cursorLine - Math.floor(INPUT_MAX_LINES / 2), lines.length - INPUT_MAX_LINES));
  const visible = lines.slice(start, start + INPUT_MAX_LINES);

  return h(
    Box,
    { flexDirection: 'column' },
    start > 0 ? h(Text, { color: theme.dim }, `  ⌃ ${start} earlier line(s)`) : null,
    ...visible.map((line, row) => {
      const absolute = start + row;
      const key = `in${absolute}`;
      if (absolute !== cursorLine) {
        return h(Text, { key, color: theme.dim }, `  ${line || ' '}`);
      }
      const before = line.slice(0, cursorCol);
      const at = line[cursorCol] || ' ';
      const after = line.slice(cursorCol + 1);
      return h(
        Text,
        { key },
        '  ',
        before,
        h(Text, { inverse: true }, at),
        after,
      );
    }),
    start + INPUT_MAX_LINES < lines.length
      ? h(Text, { color: theme.dim }, `  ⌄ ${lines.length - start - INPUT_MAX_LINES} more line(s)`)
      : null,
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function NeoTerminal({ cli, agent, client, commands, config, moduleName = 'agent' }) {
  const { exit } = useApp();
  const theme = resolveTheme(config?.theme === 'auto' ? 'dark' : config?.theme);
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
  const [health, setHealth] = useState('checking');
  const [budget, setBudget] = useState(null);
  const [workerInfo, setWorkerInfo] = useState(null);
  const [marker, setMarker] = useState('');
  const [activity, setActivity] = useState(null);
  const [activeModel, setActiveModel] = useState('');
  const [permMode, setPermMode] = useState(agent?.permissions?.mode?.() || config?.permissionMode || 'ask');
  const [toolCount, setToolCount] = useState(() => agent?.registry?.list?.()?.length || 0);
  const [msgCount, setMsgCount] = useState(0);
  const [viewport, setViewport] = useState(() => ({ width: columns(), height: process.stdout.rows || 24 }));
  const [historyIndex, setHistoryIndex] = useState(null);
  const historyRef = useRef([]);
  const historyDraftRef = useRef('');
  const idRef = useRef(0);
  const liveAssistantRef = useRef(null);
  const permissionResolveRef = useRef(null);
  const shellAbortRef = useRef(null);
  const spin = useSpinner(busy || Boolean(permission));

  useEffect(() => {
    const onResize = () => setViewport({ width: process.stdout.columns || 80, height: process.stdout.rows || 24 });
    process.stdout.on('resize', onResize);
    return () => process.stdout.removeListener('resize', onResize);
  }, []);

  const maxSteps = config?.maxSteps || 60;
  const hints = permission
    ? 'y allow · a always · n deny'
    : overlay
      ? '↑↓ move · enter select · esc close'
      : busy
        ? 'esc cancel · ctrl+t tools · ctrl+k help'
        : 'enter send · ! shell · / commands · ctrl+o model · ctrl+k help';

  // Keep the Worker connection and its published usage/budget details visible.
  // The status endpoint is public; the chat endpoint uses the configured key.
  useEffect(() => {
    let alive = true;
    const refreshProvider = async () => {
      try {
        const res = await client?.health?.();
        if (alive) { setHealth(res?.ok ? 'online' : 'offline'); setBudget(res?.data?.budget || null); }
      } catch (e) {
        console.debug?.(`Health check failed: ${e.message}`);
        if (alive) setHealth('offline');
      }
      if (config?.provider === 'worker') {
        try {
          const status = await client?.status?.();
          if (alive) setWorkerInfo(status || null);
        } catch (e) {
          console.debug?.(`Worker status check failed: ${e.message}`);
          if (alive) setWorkerInfo(null);
        }
      } else if (alive) setWorkerInfo(null);
    };
    (async () => {
      try {
        const names = await commands?.names?.();
        if (alive && names?.length) setCommandItems([...names, ...PSEUDO_COMMANDS]);
      } catch (e) {
        console.debug?.(`Failed to load command names: ${e.message}`);
      }
      await refreshProvider();
    })();
    const id = setInterval(refreshProvider, 45000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [client, commands]);

  const refreshChrome = () => {
    setSessionId(cli?.sessionId);
    setModel(config?.model || 'auto');
    setPermMode(agent?.permissions?.mode?.() || config?.permissionMode || 'ask');
    setToolCount(agent?.registry?.list?.()?.length || 0);
    try {
      setMsgCount(agent?.getOrCreateSession?.(cli?.sessionId)?.messages?.length || 0);
    } catch (e) {
      console.debug?.(`Failed to get message count: ${e.message}`);
    }
  };

  useEffect(refreshChrome);

  const push = (item) => setItems((previous) => [...previous, item]);
  const pushSystem = (text, role = 'system') => push({ id: `s${++idRef.current}`, role, text, done: true });

  const finalizeTurn = () => {
    const assistantId = liveAssistantRef.current;
    liveAssistantRef.current = null;
    shellAbortRef.current = null;
    setItems((previous) =>
      previous.map((item) => {
        if (item.id === assistantId) return { ...item, done: true };
        if (item.role === 'tool' && item.status === 'running') {
          return { ...item, status: 'done', done: true, durationMs: item.startedAt ? Date.now() - item.startedAt : undefined };
        }
        return item;
      }),
    );
  };

  // Activity phase helpers — keep the `since` timestamp stable while the phase
  // is unchanged so the elapsed timer keeps counting instead of resetting on
  // every streamed delta.
  const setPhase = (kind, detail = '') =>
    setActivity((previous) => {
      if (previous && previous.kind === kind) {
        return previous.detail === detail ? previous : { ...previous, detail };
      }
      return { kind, detail, since: Date.now() };
    });
  const resetPhase = (kind, detail = '') => setActivity({ kind, detail, since: Date.now() });

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
      setPhase('streaming');
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
      if (!activity || (activity.kind !== 'tool' && activity.kind !== 'args')) setPhase('reasoning');
    } else if (event.type === EVENT.TOOL_ARGS) {
      setItems((previous) => {
        const index = previous
          .map((item) => item.role === 'tool' && item.status === 'running' && item.scope === scope)
          .lastIndexOf(true);
        const fallback = index < 0 ? previous.map((item) => item.role === 'tool' && item.status === 'running').lastIndexOf(true) : index;
        if (fallback < 0) return previous;
        const first = event.tool_calls?.[0];
        if (!first) return previous;
        const next = previous.slice();
        next[fallback] = { ...next[fallback], name: first.name || next[fallback].name, args: safeArgs(first.arguments) };
        return next;
      });
      setPhase('args', event.tool_calls?.[0]?.name || '');
    } else if (event.type === EVENT.TOOL_START) {
      const assistantId = liveAssistantRef.current;
      liveAssistantRef.current = null;
      const id = `t${++idRef.current}`;
      setItems((previous) => [
        ...previous.map((item) => (item.id === assistantId ? { ...item, done: true } : item)),
        { id, role: 'tool', name: event.name, args: event.args, status: 'running', done: false, scope, startedAt: Date.now() },
      ]);
      resetPhase('tool', `${event.name}${shortArgs(event.args) ? ` ${shortArgs(event.args)}` : ''}`);
    } else if (event.type === EVENT.TOOL_END) {
      setPhase('thinking');
      setItems((previous) => {
        const index = previous
          .map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name && item.scope === scope)
          .lastIndexOf(true);
        const fallback =
          index < 0
            ? previous.map((item) => item.role === 'tool' && item.status === 'running' && item.name === event.name).lastIndexOf(true)
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
          durationMs: next[fallback].startedAt ? Date.now() - next[fallback].startedAt : undefined,
        };
        return next;
      });
    } else if (event.type === EVENT.TODOS) setTodos(event.todos || []);
    else if (event.type === EVENT.STEP) {
      setStep(event.current || 0);
      resetPhase('thinking', event.message || '');
    } else if (event.type === EVENT.WARNING) pushSystem(event.text, 'warning');
    else if (event.type === EVENT.ERROR) pushSystem(event.text, 'error');
    else if (event.type === EVENT.CHECKPOINT)
      pushSystem(`checkpoint ${event.checkpoint?.id} saved (${event.checkpoint?.label})`);
    else if (event.type === EVENT.CHECK_START) resetPhase('check', event.command);
    else if (event.type === EVENT.CHECK_END) {
      pushSystem(`▸ check ${event.code === 0 ? 'passed' : `failed (exit ${event.code})`}: ${event.command}`);
      setPhase('thinking');
    } else if (event.type === EVENT.SUBAGENT_START) {
      pushSystem(`↳ ${event.subagentType || 'subagent'}: ${event.description || ''}`);
      resetPhase('subagent', event.subagentType || event.description || '');
    } else if (event.type === EVENT.SUBAGENT_END) {
      pushSystem(`↳ ${event.subagentType || 'subagent'} finished`);
      setPhase('thinking');
    } else if (event.type === EVENT.MARKER)
      setMarker(`${event.name || 'marker'} ${(Date.now() - (event.timestamp || Date.now())) / 1000}s`);
    else if (event.type === EVENT.MODEL) setActiveModel(event.model || '');
    else if (event.type === EVENT.TURN) {
      const line = formatTurnSummary(event);
      if (line) pushSystem(line, 'turn');
    } else if (event.type === EVENT.DONE) {
      setActivity(null);
      refreshChrome();
    }
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
    try {
      shellAbortRef.current?.abort();
    } catch {
      /* ignore */
    }
  };

  const remember = (line) => {
    const history = historyRef.current;
    if (history[history.length - 1] !== line) history.push(line);
    if (history.length > 200) history.splice(0, history.length - 200);
    setHistoryIndex(null);
  };

  const runCommand = async (line) => {
    if (line === '/exit' || line === '/quit') return exit();
    if (line === '/retry') return retryLast();
    if (line === '/history') {
      const history = historyRef.current;
      if (!history.length) pushSystem('No prompts yet.');
      else pushSystem(history.slice(-15).map((entry, index) => `  ${index + 1}. ${oneLine(entry, columns() - 8)}`).join('\n'));
      return;
    }
    const original = { log: console.log, error: console.error };
    const logs = [];
    const sink = (...args) => logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
    console.log = sink;
    console.error = sink;
    setBusy(true);
    resetPhase('thinking', line);
    let result;
    try {
      result = await commands.handle(line);
    } catch (error) {
      logs.push(`Error: ${error.message}`);
    } finally {
      console.log = original.log;
      console.error = original.error;
      setBusy(false);
      setActivity(null);
    }
    if (result === 'exit') return exit();
    if (logs.length) pushSystem(logs.map(stripAnsi).join('\n'));
    refreshChrome();
    if (result && typeof result === 'object' && result.prompt) await runPrompt(result.prompt);
  };

  const runPrompt = async (line) => {
    push({ id: `u${++idRef.current}`, role: 'user', text: line, done: true });
    setBusy(true);
    setStep(0);
    setMarker('');
    setActiveModel('');
    resetPhase('thinking');
    try {
      await agent.chat({ message: line, sessionId: cli.sessionId, onEvent, onPermission: requestPermission });
    } catch (error) {
      pushSystem(`Error: ${error.message}`, 'error');
    } finally {
      finalizeTurn();
      setStep(0);
      setBusy(false);
      setActivity(null);
      refreshChrome();
    }
  };

  // `! <command>` — opencode-style shell passthrough using the bash tool.
  const runShell = async (command) => {
    push({ id: `u${++idRef.current}`, role: 'user', text: command, shell: true, done: true });
    const id = `t${++idRef.current}`;
    setItems((previous) => [
      ...previous,
      { id, role: 'tool', name: 'bash', args: { command }, status: 'running', done: false, startedAt: Date.now() },
    ]);
    setBusy(true);
    const controller = new AbortController();
    shellAbortRef.current = controller;
    resetPhase('tool', `bash ${command}`);
    try {
      const bash = agent.registry.get('bash');
      const result = await bash.run({ command, signal: controller.signal });
      const output = result.output || '';
      const failed = result.metadata?.error || /^Error\b/.test(output) || (typeof result.metadata?.code === 'number' && result.metadata.code !== 0);
      setItems((previous) =>
        previous.map((item) =>
          item.id === id
            ? {
                ...item,
                status: failed ? 'error' : 'done',
                output,
                diff: result.metadata?.diff,
                done: true,
                durationMs: item.startedAt ? Date.now() - item.startedAt : undefined,
              }
            : item,
        ),
      );
    } catch (error) {
      setItems((previous) =>
        previous.map((item) =>
          item.id === id ? { ...item, status: 'error', output: `Error: ${error.message}`, done: true } : item,
        ),
      );
    } finally {
      shellAbortRef.current = null;
      setBusy(false);
      setActivity(null);
    }
  };

  // /retry — drop the last user turn from the transcript and the session, run it again.
  const retryLast = async () => {
    if (busy) return pushSystem('Still working — wait or press esc first.', 'warning');
    let lastUserIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].role === 'user' && !items[i].shell) {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex < 0) return pushSystem('Nothing to retry.', 'warning');
    const prompt = items[lastUserIndex].text;
    try {
      const sess = agent.getOrCreateSession(cli.sessionId);
      let cut = -1;
      for (let i = sess.messages.length - 1; i >= 0; i--) {
        if (sess.messages[i].role === 'user') {
          cut = i;
          break;
        }
      }
      if (cut >= 0) sess.messages = sess.messages.slice(0, cut);
    } catch (e) {
      console.debug?.(`Failed to cut session messages: ${e.message}`);
      /* best effort */
    }
    setItems((previous) => previous.slice(0, lastUserIndex));
    liveAssistantRef.current = null;
    await runPrompt(prompt);
  };

  const submit = async (value) => {
    let line = value.replace(/\s+$/, '');
    // Enter on a bare/partial slash runs the highlighted palette command
    // instead of falling through to "Unknown command: ."
    if (line.startsWith('/')) {
      const exact = commandItems.some((item) => item.name === line);
      if (!line.includes(' ') && !exact) {
        const matches = paletteMatches(commandItems, line);
        if (matches.length) line = matches[paletteIndex % matches.length].name;
        else if (line === '/') {
          setInput('');
          setCursor(0);
          return;
        }
      }
    }
    setInput('');
    setCursor(0);
    setPaletteIndex(0);
    setHistoryIndex(null);
    if (!line || permission || overlay) return;
    if (busy) return pushSystem('Still working — press Esc to cancel the current turn.');
    if (line.startsWith('!') && line.length > 1) return runShell(line.slice(1).trim());
    if (line.startsWith('/')) return runCommand(line);
    remember(line);
    await runPrompt(line);
  };

  const openModels = async () => {
    setOverlay({ kind: 'models', loading: true, models: [], index: 0 });
    const models = (await (client?.models?.() || cli?.client?.models?.() || Promise.resolve([]))) || [];
    setOverlay((current) => (current?.kind === 'models' ? {
      ...current,
      loading: false,
      models: orderModelsForPicker(models, { autoAllowed: (config?.provider || 'worker') === 'worker' }),
      index: 0,
    } : current));
  };

  const openSessions = async () => {
    const sessions = (await (cli?.sessionStore?.list?.() || Promise.resolve([]))) || [];
    setOverlay({ kind: 'sessions', sessions, index: 0, activeId: cli?.sessionId });
  };

  const openTools = () => {
    let tools = [];
    try {
      tools = agent?.registry?.describe?.() || [];
    } catch (e) {
      console.debug?.(`Failed to get tools: ${e.message}`);
      tools = [];
    }
    setOverlay({ kind: 'tools', tools, index: 0 });
  };

  const applyModel = async (name) => {
    if (!name) return;
    await runCommand(`/model ${name}`);
    pushSystem(`Model set to ${name}.`);
  };

  const applySession = async (id) => {
    const sess = await agent.loadSession(id);
    if (!sess) return pushSystem(`Session ${id} not found.`, 'error');
    cli.sessionId = sess.id;
    setSessionId(sess.id);
    setItems([]);
    liveAssistantRef.current = null;
    setTodos(sess.todos || []);
    pushSystem(`Resumed session ${shortId(sess.id)} (${sess.messages.length} messages).`);
    refreshChrome();
  };

  const historyMove = (delta) => {
    const history = historyRef.current;
    if (!history.length) return;
    if (historyIndex === null) {
      if (delta > 0) return;
      historyDraftRef.current = input;
      const next = history.length - 1;
      setHistoryIndex(next);
      setInput(history[next]);
      setCursor(history[next].length);
      return;
    }
    const next = historyIndex + delta;
    if (next < 0) {
      setHistoryIndex(null);
      setInput(historyDraftRef.current);
      setCursor(historyDraftRef.current.length);
      return;
    }
    if (next >= history.length) {
      setHistoryIndex(null);
      setInput('');
      setCursor(0);
      return;
    }
    setHistoryIndex(next);
    setInput(history[next]);
    setCursor(history[next].length);
  };

  useInput((char, key) => {
    if (permission) {
      const lower = String(char || '').toLowerCase();
      if (lower === 'y') resolvePermission('allow');
      else if (lower === 'a') resolvePermission('always');
      else if (lower === 'n' || key.escape) resolvePermission('deny');
      return;
    }

    if (overlay) {
      const length = overlayLength(overlay);
      if (key.escape || (key.ctrl && String(char).toLowerCase() === 'k')) return setOverlay(null);
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
        if (overlay.kind === 'tools') return setOverlay(null);
      }
      return;
    }

    if (key.ctrl && char === 'c') {
      if (busy) cancelAgent();
      else exit();
      return;
    }
    if (key.escape) {
      if (busy) return cancelAgent();
      if (input) {
        setInput('');
        setCursor(0);
        setHistoryIndex(null);
      }
      return;
    }
    if (key.ctrl && char === 'j') {
      setInput(input.slice(0, cursor) + '\n' + input.slice(cursor));
      setCursor(cursor + 1);
      return;
    }
    if (key.ctrl && String(char || '').toLowerCase() === 'l') {
      process.stdout.write('\u001b[2J\u001b[H');
      liveAssistantRef.current = null;
      setItems([]);
      return;
    }
    if (key.ctrl && String(char || '').toLowerCase() === 'p') return setShowPlan((value) => !value);
    if (key.ctrl && String(char || '').toLowerCase() === 'r') return setShowReasoning((value) => !value);
    if (key.ctrl && String(char || '').toLowerCase() === 'o') return openModels();
    if (key.ctrl && String(char || '').toLowerCase() === 's') return openSessions();
    if (key.ctrl && String(char || '').toLowerCase() === 't') return openTools();
    if (key.ctrl && String(char || '').toLowerCase() === 'k') return setOverlay((o) => (o?.kind === 'help' ? null : { kind: 'help' }));
    if (key.ctrl && String(char || '').toLowerCase() === 'a') return setCursor(0);
    if (key.ctrl && String(char || '').toLowerCase() === 'e') return setCursor(input.length);
    if (key.ctrl && String(char || '').toLowerCase() === 'u') {
      setInput(input.slice(cursor));
      setCursor(0);
      return;
    }
    if (key.ctrl && String(char || '').toLowerCase() === 'w') {
      const before = input.slice(0, cursor).replace(/\S+\s*$/, '');
      setInput(before + input.slice(cursor));
      setCursor(before.length);
      return;
    }
    if (key.ctrl || key.meta) {
      if (key.return && (key.shift || key.alt || key.meta)) {
        setInput(input.slice(0, cursor) + '\n' + input.slice(cursor));
        setCursor(cursor + 1);
      }
      return;
    }

    if (key.tab) {
      const matches = input.startsWith('/') ? paletteMatches(commandItems, input) : [];
      if (matches.length) {
        const completed = `${matches[paletteIndex % matches.length].name} `;
        setInput(completed);
        setCursor(completed.length);
      } else setExpandedTools((value) => !value);
      return;
    }

    if (key.upArrow) {
      if (input.startsWith('/')) return setPaletteIndex((i) => Math.max(0, i - 1));
      return historyMove(-1);
    }
    if (key.downArrow) {
      if (input.startsWith('/')) return setPaletteIndex((i) => i + 1);
      return historyMove(1);
    }
    if (key.return) {
      if (key.shift || key.alt) {
        setInput(input.slice(0, cursor) + '\n' + input.slice(cursor));
        setCursor(cursor + 1);
        return;
      }
      return submit(input);
    }
    if (key.home || (key.ctrl && char === 'a')) return setCursor(0);
    if (key.end) return setCursor(input.length);
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
    if (char && char.length) {
      const clean = char.replace(/[\r]/g, '');
      if (!clean) return;
      // A bare LF is the second half of a Windows CRLF Enter (or an echoed
      // newline) — never insert it, or the next Enter submits a phantom line.
      if (clean === '\n') return;
      if (clean.includes('\n')) {
        setInput(input.slice(0, cursor) + clean + input.slice(cursor));
        setCursor(cursor + clean.length);
        return;
      }
      setInput(input.slice(0, cursor) + clean + input.slice(cursor));
      setCursor(cursor + clean.length);
      setPaletteIndex(0);
      if (historyIndex !== null) setHistoryIndex(null);
    }
  });

  const done = useMemo(() => items.filter((item) => item.done), [items]);
  const live = items.filter((item) => !item.done);
  const showPalette = !overlay && !permission && input.startsWith('/') && commandItems.length > 0;
  const paletteIndexSafe = showPalette ? paletteIndex % Math.max(1, paletteMatches(commandItems, input).length) : 0;
  const healthColor = health === 'online' ? theme.ok : health === 'checking' ? theme.warn : theme.error;
  const healthLabel = health === 'online' ? 'online' : health === 'checking' ? 'connecting' : 'offline';
  // Live activity line (opencode-style): phase, detail, elapsed and the model
  // the worker actually routed to. Recomputed on each spinner frame.
  const liveAssistant = live.find((item) => item.role === 'assistant');
  const activityKind = activity?.kind || 'working';
  const activityText = oneLine(
    activityLine({ activity, spin, activeModel, chars: liveAssistant?.text?.length || 0 }),
    Math.max(20, columns() - 3),
  );
  const activityColor = activityPhaseColor(activityKind, theme);

  // Budget-aware status line. Widths are computed so the row can never wrap
  // (a wrapped status row corrupts the pinned frame on narrow terminals).
  const shownModel = activeModel || model;
  const statusHead = `${shownModel} · perm ${permMode} · `;
  const statusHealth = `● ${healthLabel}`;
  const statusBudgetText = budgetSummary(budget);
  const statusBudget = statusBudgetText ? ` · ${statusBudgetText}` : '';
  const statusRightFull = `${shortId(sessionId)} · ${msgCount} msgs · ${toolCount} tools · ${hints}`;
  const statusFixed = statusHead.length + statusHealth.length + statusBudget.length;
  const statusRight = oneLine(statusRightFull, Math.max(18, columns() - statusFixed - 20));
  const statusStepRoom = Math.max(8, columns() - statusRight.length - statusFixed - 1);
  const statusStep = oneLine(`step ${step}/${maxSteps}${marker ? ` · ${marker}` : ''}`, statusStepRoom);
  const compact = viewport.width < 88 || viewport.height < 28;
  const statusLine = oneLine(
    `${shownModel} · ${statusHealth} · perm ${permMode}${statusBudget} · ${statusStep} · session ${shortId(sessionId)} · ${msgCount} msgs · ${toolCount} tools${busy ? ' · working' : ''} · ${hints}`,
    Math.max(20, viewport.width - 2),
  );
  const workPath = oneLine(cli?.cwd || process.cwd(), Math.max(20, columns() - 4));
  const usageToday = workerInfo?.usage?.today;
  const workerLine = workerInfo
    ? `Worker ${workerInfo.version ? `v${workerInfo.version}` : workerInfo.name || 'connected'} · ${config?.workerUrl || ''} · ${workerInfo.budget?.mode || 'budget unknown'} · ${workerInfo.budget?.free_remaining ?? '?'} free neurons · $${Number(workerInfo.budget?.usd_month || 0).toFixed(3)} this month · ${usageToday?.requests || 0} requests`
    : config?.provider === 'worker'
      ? `Worker ${healthLabel} · ${config?.workerUrl || '(URL not configured)'}`
      : `${config?.provider || 'worker'} provider · ${healthLabel}`;

  // Ink places completed transcript output above the live workbench area.
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { items: done }, (item) => renderItem(item, spin, expandedTools, showReasoning, theme)),
    h(
      Box,
      { flexDirection: 'row', justifyContent: 'space-between' },
      h(Text, { color: theme.primary, bold: true }, ' AGENT TERMINAL '),
      h(Text, { color: theme.dim }, oneLine(pathBasename(workPath), Math.max(12, Math.floor(viewport.width / 2)))),
    ),
    live.map((item) => renderItem(item, spin, expandedTools, showReasoning, theme)),
    busy && !permission ? h(Text, { color: activityColor }, `  ${activityText}`) : null,
    h(PlanPanel, { todos, step, maxSteps, visible: showPlan, compact, theme }),
    h(Text, { color: theme.dim }, `  📁 ${workPath}`),
    h(Text, { color: healthColor }, `  ◉ ${oneLine(workerLine, Math.max(30, columns() - 4))}`),
    h(PermissionPanel, { request: permission, theme }),
    h(Overlay, { overlay, theme }),
    showPalette ? h(CommandPalette, { items: commandItems, filter: input, index: paletteIndexSafe, theme }) : null,
    h(
      Box,
      { flexDirection: 'column', borderStyle: 'round', borderColor: permission ? theme.warn : theme.primary, paddingX: 1, marginTop: 1 },
      h(
        Box,
        { flexDirection: 'row' },
        h(Text, { color: permission ? theme.warn : theme.user, bold: true }, permission ? ' ⚠ ' : ' › '),
        h(
          Box,
          { flexDirection: 'column', flexGrow: 1 },
          permission
            ? h(Text, { color: theme.warn }, 'answer the permission prompt above — y / a / n')
            : h(InputEditor, {
                value: input,
                cursor,
                theme,
                focused: !overlay,
                placeholder: busy ? 'working — esc to cancel…' : `message ${moduleName}  ·  ! shell  ·  / commands`,
              }),
        ),
      ),
    ),
    h(Text, { color: healthColor }, `  ${statusLine}`),
  );
}

function safeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.debug?.(`Failed to parse args: ${e.message}`);
    return { _raw: String(raw).slice(0, 120) };
  }
}

export async function startNeoTerminal({ cli, agent, client, commands, config, moduleName = 'agent' }) {
  const useAlternateScreen = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (useAlternateScreen) process.stdout.write('\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H');
  try {
    const app = render(h(NeoTerminal, { cli, agent, client, commands, config, moduleName }), { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    if (useAlternateScreen) process.stdout.write('\u001b[0m\u001b[?25h\u001b[?1049l');
  }
}

function pathBasename(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).pop() || normalized || 'workspace';
}
