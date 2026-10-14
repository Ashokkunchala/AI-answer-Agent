# @devops-ai/agent — `workercli`

Local, opencode-style terminal agent for the DevOps AI Agent Suite. It runs an
**agentic tool loop** in your terminal and talks to a local (or remote)
Cloudflare Worker as its model backend.

```text
you ──▶ workercli (tool loop) ──▶ POST /v1/chat/completions ──▶ Worker ──▶ Workers AI
              ▲                                                             │
              └────────────── tool_calls / content ◀──────────────────────┘
```

## The interface

Just run `agent` (or `workercli`) in a terminal and you get an opencode-style
full-screen terminal UI:

```text
› summarize this repo and list the packages

Hello world
  ⏺ bash {"command":"ls"}
     ⎿ packages
       package.json
 all done

› Ask anything, or type / for a command
auto · C:\dev\project                                    enter send · /help · ctrl+c exit
```

- **Enter** sends, **Esc** cancels a running turn, **Ctrl+C** quits.
- Assistant text streams live; tool calls render as `⏺ name args` with their
  output beneath (`⎿ …`), turning red (`✗`) on error.
- Slash commands run inside the UI and print their output inline.

If stdin/stdout is not a TTY (e.g. piped), it falls back to a plain line REPL.

## Abilities

- **Agentic loop** — the model can call tools, see results, and iterate until done.
- **Tools**
  - `read`, `write`, `edit`, `list` — filesystem
  - `glob`, `grep`, `projectmap` — repository search and whole-project inventory
  - `bash` — run shell commands (cmd.exe on Windows, /bin/sh elsewhere)
  - `webfetch`, `websearch` — fetch URLs and search the web (DuckDuckGo)
  - `task` — spawn a sub-agent for a self-contained multi-step job
- **Streaming** — tokens stream to the terminal when tools are disabled.
- **Project context** — reads `AGENTS.md`, `.agent/AGENTS.md` or `CLAUDE.md` if present.
- **Project analysis preflight** — whole-project requests receive a bounded source inventory before the model investigates manifests and entry points.
- **Sessions** — persistent in-memory conversation with `/clear` to reset.
- **Worker passthrough** — `/health`, `/v1/models`, interview session/report endpoints.

## Workbench controls

The terminal UI is designed for longer coding tasks instead of one-shot chat:

- A **Work plan** panel shows live `todowrite` progress and the current agent step.
- Tool results are compact by default; press **Tab** to expand or collapse their output.
- Press **Ctrl+P** to show or hide the work plan, **Ctrl+L** to clear the visible transcript, and **Esc** to cancel an active task.
- When automatic approval is disabled, the UI stops at each write, edit, or shell command: **Y** allows it once, **A** allows that tool for the current task, and **N** denies it.
- Use natural language for substantial jobs, for example: `Review the worker routing, fix the fallback bug, and run the tests.` The agent plans, investigates, edits, and checks its work in one task.

## Local setup (worker + cli)

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

2. Run the Worker locally with `wrangler dev` (needs a Cloudflare account with
   Workers AI enabled, for the `AI` binding):

   ```bash
   npm run dev:worker          # from repo root
   # or: cd packages/worker && npx wrangler dev   (defaults to http://127.0.0.1:8787)
   ```

3. Link the CLI so you can launch it by typing `agent` from anywhere:

   ```bash
   npm run link:agent          # from repo root (= npm link -w packages/agent)
   # or: cd packages/agent && npm link
   ```

4. Launch it:

   ```bash
   agent                       # full-screen terminal UI (opencode-style)
   agent run "summarize the packages/"
   ```

   Without linking, run it via the paths below.

### Fast project setup

From the repository root, the following gives a new project a complete local
terminal-agent setup. It creates `.agent/config.json` in the current project
and checks the backend before you begin:

```bash
npm run dev:worker             # separate terminal; starts the local Worker
npm run link:agent             # once, makes `agent` available on PATH
agent setup --worker http://127.0.0.1:8787 --model auto
agent doctor
agent                          # opens the full-screen UI
```

For a deployed Worker, replace the local URL and optionally provide its API
key:

```bash
agent setup --worker https://your-worker.example.workers.dev --api-key dvops_... --model auto
```

`agent doctor` validates Node, the terminal, the active workspace config,
Worker health, and model discovery. It is the quickest way to diagnose a
terminal setup that cannot answer requests.

## Configure

The CLI reads config from (first match wins):

1. `<cwd>/.agent/config.json`
2. `<cwd>/.workercli/config.json`
3. `packages/agent/.agent/config.json` (shipped default)
4. `~/.config/workercli/config.json`, `~/.workercli/config.json`, and the legacy `devops-agent` paths

The shipped default already points at the local worker:

```json
{
  "workerUrl": "http://127.0.0.1:8787",
  "model": "gpt-oss-20b",
  "tools": true,
  "streaming": true,
  "maxSteps": 25,
  "temperature": 0.2
}
```

Override and save:

```bash
node packages/agent/bin/workercli.js config --set workerUrl=http://127.0.0.1:8787 --save
node packages/agent/bin/workercli.js config --set model=auto --save
node packages/agent/bin/workercli.js config --set tools=true --save
```

## Usage

```bash
node packages/agent/bin/workercli.js            # open the TUI (same as `agent`)
node packages/agent/bin/workercli.js tui        # open the TUI explicitly
node packages/agent/bin/workercli.js repl       # plain line REPL
node packages/agent/bin/workercli.js run "..."  # full agentic tool loop, one-shot
node packages/agent/bin/workercli.js chat "..."  # single chat turn
node packages/agent/bin/workercli.js health
node packages/agent/bin/workercli.js models
node packages/agent/bin/workercli.js setup --worker http://127.0.0.1:8787 --model auto
node packages/agent/bin/workercli.js doctor
```

### Slash commands (in the TUI or REPL)

- `/help`, `/tools`, `/model [name]`, `/models`
- `/cwd [path]`, `/clear`, `/config`, `/set key=value`
- `/permissions [on|off]`, `/doctor`
- `/health`
- `/session`, `/context <id>`, `/finalize <id>`, `/report <id>`
- `/exit`

## How tool calling works

The CLI sends OpenAI-style `tools` to `POST /v1/chat/completions` with
`raw: true` (so the Worker does not inject its own DevOps system prompt). The
Worker forwards `tools` to Workers AI and returns `tool_calls`. Because Workers
AI only returns reliable tool calls when buffered, the agent uses non-streaming
requests while tools are enabled, then streams the final answer in chat mode.

## Not for interview/voice

This package is the developer-facing coding agent. The Electron desktop app
(`packages/desktop`) remains the interview/meeting overlay.
