# @devops-ai/agent — `agent`

Standalone terminal coding agent with its own full-screen interface, local tool
loop, sessions, permissions, checkpoints, subagents and skill system. It uses
your Cloudflare Worker or Google Gemini API URL and API key. The terminal UI is the agent's own workbench;
Claude Code and OpenCode are product references, not required runtimes.

```text
you ──▶ agent terminal (tool loop) ──▶ your Cloudflare Worker (API key)
              ▲                                                             │
              └────────────── tool_calls / content ◀──────────────────────┘
```

## The interface

Run `agent` (or the legacy `workercli` alias) from any project directory to
open the Agent Terminal full-screen interface:

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
- **Skills** — discovers project skills in `.agent/skills`, `.agents/skills`, `.claude/skills` and `.codex/skills`; also loads user skills from standard Agents, Codex, Claude and agent-config directories, including installed Codex plugin skills.
- **Project analysis preflight** — whole-project requests receive a bounded source inventory before the model investigates manifests and entry points.
- **Sessions** — persistent in-memory conversation with `/clear` to reset.
- **Optional Worker tools** — `/health`, `/v1/models`, usage, routing, API-key and interview session/report endpoints.

## Workbench controls

The terminal UI is designed for longer coding tasks instead of one-shot chat:

- A **Work plan** panel shows live `todowrite` progress and the current agent step.
- Tool results are compact by default; press **Tab** to expand or collapse their output.
- Press **Ctrl+P** to show or hide the work plan, **Ctrl+L** to clear the visible transcript, and **Esc** to cancel an active task.
- By default, the agent carries out workspace edits and CLI commands without stopping for approval. Use `/permissions ask` to review changes before they run, or `/permissions deny` to block mutations.
- Use natural language for substantial jobs, for example: `Review the worker routing, fix the fallback bug, and run the tests.` The agent plans, investigates, edits, and checks its work in one task.

## Install and launch

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

2. Set your Worker API key. The interactive terminal prompts for it when it is
   missing and stores it in your user config, or set it in the environment:

   ```bash
   # PowerShell
   $env:WORKER_API_KEY = "your-worker-key"
   agent setup --worker https://your-worker.example.workers.dev --model auto
   agent doctor
   ```

For Gemini, keep the key in the shell environment and select the provider:

```powershell
$env:GEMINI_API_KEY = "your-gemini-key"
agent setup --provider gemini --model gemini-3.8-flash --global
agent doctor
```

The default Gemini URL is `https://generativelanguage.googleapis.com/v1beta/openai`.
Override it with `--gemini-url` when needed. `GEMINI_API_KEY` is read at runtime
and is not written to the agent config by this setup flow.

3. Link the CLI globally so it can be launched from any project directory:

   ```bash
   npm run install:agent:global
   ```

4. Open the standalone full-screen terminal with `agent` or `agent-terminal` from any project folder.

### Worker connection

```bash
npm run dev:worker
agent setup --worker http://127.0.0.1:8787 --model auto
agent doctor
agent
```

For a deployed Worker, provide its URL and API key:

```bash
agent setup --worker https://your-worker.example.workers.dev --api-key your-worker-key --model auto
```

`agent doctor` validates Node, the terminal, the active workspace config,
provider health, and model discovery.

## Configure

The CLI reads config from (first match wins):

1. `<cwd>/.agent/config.json`
2. `<cwd>/.workercli/config.json`
3. `~/.config/agent-terminal/config.json` or `~/.agent-terminal/config.json`
4. `packages/agent/.agent/config.json` (shipped default)
5. Legacy `workercli` and `devops-agent` config paths

The legacy default profile selects the optional Worker backend:

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

Global settings are saved under `~/.config/agent-terminal/config.json`; project settings stay
in `.agent/config.json`.

Override Worker settings and save:

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

Skills are loaded from project roots first, then user-level roots. Add custom
directories with the `skillDirs` config array. The agent lists skill summaries
in its system context and loads full instructions on demand with the `skill`
tool.

## How tool calling works

The CLI sends OpenAI-style `tools` to `POST /v1/chat/completions` with
`raw: true` (so the Worker does not inject its own DevOps system prompt). The
Worker forwards `tools` to Workers AI and returns `tool_calls`. Because Workers
AI only returns reliable tool calls when buffered, the agent uses non-streaming
requests while tools are enabled, then streams the final answer in chat mode.

## Interview and voice features

Interview and voice features are handled by the Worker and its connected clients.
