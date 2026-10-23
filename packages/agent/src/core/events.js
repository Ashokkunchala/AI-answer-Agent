// Shared event contract between AgentCore and every UI (Ink TUI, REPL,
// one-shot renderers, remote UIs driving the agent over the Worker).
//
// Every event has a `type`. Agents emit these through `onEvent(event)`.
// Keep this list in sync with the renderers in src/ui/*.

export const EVENT = {
  // Streaming assistant text. `text` is an incremental delta.
  CONTENT: 'content',
  // Reasoning/thinking text (models that expose it). Incremental delta.
  REASONING: 'reasoning',
  // Agent loop progress.
  STEP: 'step',
  // A tool call is about to run.
  TOOL_START: 'tool_start',
  // A tool call finished. `result` = { title, output, metadata }.
  TOOL_END: 'tool_end',
  // Incremental tool-call argument streaming (before TOOL_START).
  TOOL_ARGS: 'tool_args',
  // The plan changed.
  TODOS: 'todos',
  // Permission request / resolution.
  PERMISSION_REQUEST: 'permission_request',
  PERMISSION_RESOLVED: 'permission_resolved',
  // Post-edit project check.
  CHECK_START: 'check_start',
  CHECK_END: 'check_end',
  // A checkpoint was captured / restored / reverted.
  CHECKPOINT: 'checkpoint',
  // A subagent lifecycle event. `subagentId` scopes nested events.
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_END: 'subagent_end',
  // The turn finished.
  DONE: 'done',
  // A non-fatal warning or an error surfaced to the UI.
  WARNING: 'warning',
  ERROR: 'error',
  // Latency/progress markers forwarded from the Worker SSE stream.
  MARKER: 'marker',
  // The concrete model the Worker routed this turn to. `model` = model id.
  MODEL: 'model',
  // End-of-turn summary from the Worker: `usage`, `latency_ms`, `routing`,
  // `model`. Emitted once per completed model turn (stream or buffered).
  TURN: 'turn',
};

// Wrap an event stream so nested (subagent) events are tagged and can be
// rendered separately by the parent UI.
export function scopeEvents(onEvent, scope) {
  if (!onEvent) return undefined;
  return (event) => onEvent({ ...event, scope });
}

export function isToolEvent(event) {
  return event?.type === EVENT.TOOL_START || event?.type === EVENT.TOOL_END || event?.type === EVENT.TOOL_ARGS;
}
