import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import fs from 'fs-extra';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { ConfigLoader } from './config/loader.js';
import { WorkerClient } from './client/worker-client.js';
import { AgentCore } from './core/agent-core.js';
import { SessionStore } from './session/store.js';
import { Repl } from './ui/repl.js';
import { CommandRegistry } from './commands/registry.js';
import pkg from '../package.json' with { type: 'json' };

export class Cli {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.binDir = opts.binDir;
    this.sessionId = randomUUID();
    this.configLoader = new ConfigLoader({ cwd: this.cwd, binDir: this.binDir });
    this.client = new WorkerClient();
    this.agent = new AgentCore({ client: this.client, cwd: this.cwd });
    this.commands = new CommandRegistry({
      cli: this,
      client: this.client,
      agent: this.agent,
      configLoader: this.configLoader,
    });
    // Terminal setup
    this._setupTerminal();
  }

  _setupTerminal() {
    // Detect if running in a terminal with proper capabilities
    this._isTTY = process.stdout.isTTY && process.stdin.isTTY;
    this._terminalWidth = process.stdout.columns || 80;
    this._terminalHeight = process.stdout.rows || 24;

    // Handle terminal resize
    const resizeHandler = () => {
      this._terminalWidth = process.stdout.columns || 80;
      this._terminalHeight = process.stdout.rows || 24;
    };
    process.stdout.on('resize', resizeHandler);

    // Cleanup on exit
    const origExit = process.exit;
    process.exit = (code) => {
      try {
        process.stdout.removeListener('resize', resizeHandler);
      } catch {}
      return origExit(code);
    };
  }

  async initConfig() {
    const { config, source } = await this.configLoader.load();
    this.config = config;
    this.configSource = source;
    if (!config.workerUrl) config.workerUrl = 'http://127.0.0.1:8787';
    if (config.cwd) {
      this.agent.setCwd(config.cwd);
    }
    this.sessionStore = new SessionStore({ dir: config.sessionsDir });
    this.agent.setSessionStore(this.sessionStore);
    this.client.setConfig(config);
    this.agent.setConfig(config);
    await this.ensureLocalWorker();
  }

  // A global `agent` should be usable from any project directory. When the
  // configured endpoint is the bundled local Worker and it is not already
  // running, start the repository's Wrangler dev process in the background.
  // Deployed/custom Worker URLs are never started or modified.
  async ensureLocalWorker() {
    const rawArgs = process.argv.slice(2);
    if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs.includes('--version') || rawArgs.includes('-V')) return;
    if (this.config.autoStartWorker === false || !/^https?:\/\/(127\.0\.0\.1|localhost):8787\/?$/i.test(this.config.workerUrl || '')) return;
    const health = await this.client.health();
    if (health.ok) return;

    const candidates = [
      this.binDir ? resolve(this.binDir, '..', '..', '..') : null,
      this.binDir ? resolve(realpathSync(this.binDir), '..', '..', '..') : null,
      resolve(process.cwd()),
    ].filter(Boolean);
    const repoRoot = candidates.find((candidate) => existsSync(resolve(candidate, 'packages', 'worker', 'wrangler.toml')));
    if (!repoRoot) return;

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      const child = spawn(npmCommand, ['run', 'dev', '-w', 'packages/worker'], {
        cwd: repoRoot,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      this.workerProcessStarted = true;
    } catch {
      return;
    }

    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      if ((await this.client.health()).ok) return;
    }
  }

  // Render the onPermission prompt for non-interactive one-shot runs. These
  // runs have no way to ask, so they auto-approve (matching `agent run`).
  onPermission() {
    return 'allow';
  }

  async run(argv) {
    await this.initConfig();
    const program = new Command();
    const binName = basename(process.argv[1] || 'agent').replace(/\.(js|mjs|cjs)$/, '');
    program.name(binName).description('Local terminal agent (opencode-style) backed by the DevOps AI worker').version(pkg.version);

    program
      .command('run <prompt...>')
      .description('Run a single prompt through the full agentic tool loop')
      .action(async (promptParts) => {
        const prompt = promptParts.join(' ');
        await this.runOnce(prompt);
      });

    program
      .command('chat [message...]')
      .description('Chat once, or open the interactive terminal UI when no message is given')
      .option('-s, --session <id>', 'session id')
      .action(async (messageParts, opts) => {
        if (!messageParts || !messageParts.length) {
          await this.startInteractive();
          return;
        }
        const sessionId = opts.session || this.sessionId;
        this._streamed = false;
        const onEvent = (e) => this.renderEvent(e);
        const res = await this.agent.chat({ message: messageParts.join(' '), sessionId, onEvent });
        if (!this._streamed) console.log(res);
      });

    program
      .command('tui')
      .description('Open the interactive terminal UI (opencode-style)')
      .action(async () => {
        await this.startTui();
      });

    program
      .command('repl')
      .description('Start the interactive line-based REPL')
      .action(async () => {
        await this.startRepl();
      });

    program
      .command('sessions')
      .description('List saved sessions')
      .action(async () => {
        const list = await this.sessionStore.list();
        if (!list.length) {
          console.log(chalk.gray('No saved sessions yet.'));
          return;
        }
        for (const s of list) {
          console.log(`${chalk.green(s.id)}  ${chalk.gray(s.updatedAt)}  ${chalk.cyan(`${s.turns} turn(s)`)}  ${s.title}`);
        }
      });

    program
      .command('resume [id]')
      .description('Resume a saved session (most recent when id omitted) and open the UI')
      .action(async (id) => {
        let target = id;
        if (!target) {
          const list = await this.sessionStore.list();
          target = list[0]?.id;
        }
        if (!target) {
          console.log(chalk.gray('No saved sessions to resume.'));
          return;
        }
        const sess = await this.agent.loadSession(target);
        if (!sess) {
          console.log(chalk.red(`Session ${target} not found.`));
          return;
        }
        this.sessionId = sess.id;
        console.log(chalk.gray(`Resumed session ${sess.id} (${sess.messages.length} messages)`));
        await this.startInteractive();
      });

    program
      .command('config')
      .description('Show or set config')
      .option('--set <key=value>', 'set a config value')
      .option('--save', 'persist to config file')
      .action(async (opts) => {
        if (opts.set) {
          const [k, ...v] = String(opts.set).split('=');
          this.config[k] = coerce(v.join('='));
          if (opts.save || this.config.autoSave) {
            const p = await this.configLoader.save(this.config);
            console.log(chalk.green(`Saved to ${p}`));
          }
          this.client.setConfig(this.config);
          this.agent.setConfig(this.config);
        }
        console.log(JSON.stringify(this.config, null, 2));
      });

    program
      .command('setup')
      .description('Create or update a project-local agent configuration')
      .option('--worker <url>', 'Worker base URL')
      .option('--model <name>', 'model id, or "auto"')
      .option('--api-key <key>', 'Worker API key')
      .option('--no-tools', 'disable local tools')
      .option('--approve', 'auto-approve mutating tool calls')
      .option('--no-check', 'skip automatic post-edit checks')
      .action(async (opts) => {
        const next = { ...this.config };
        if (opts.worker) next.workerUrl = opts.worker;
        if (opts.model) next.model = opts.model;
        if (opts.apiKey) next.apiKey = opts.apiKey;
        if (opts.tools === false) next.tools = false;
        if (opts.approve) next.autoApprove = true;
        if (opts.check === false) next.autoCheck = false;
        const target = await this.configLoader.save(next);
        this.config = next;
        this.client.setConfig(next);
        this.agent.setConfig(next);
        console.log(chalk.green(`Configured agent for this project: ${target}`));
        console.log(chalk.gray(`worker: ${next.workerUrl}  model: ${next.model || 'auto'}  tools: ${next.tools !== false ? 'on' : 'off'}`));
        if (opts.apiKey) console.log(chalk.yellow('The project config contains an API key. Keep .agent/config.json out of version control.'));
        console.log(chalk.gray('Run `agent doctor` to verify the Worker, then `agent` to start the terminal UI.'));
      });

    program
      .command('doctor')
      .description('Check terminal, project, configuration, and Worker connectivity')
      .action(async () => {
        await this.runDoctor();
      });

    program
      .command('health')
      .description('Check worker health')
      .action(async () => {
        console.log(await this.client.health());
      });

    program
      .command('models')
      .description('List models available on the worker')
      .action(async () => {
        const models = await this.client.models();
        for (const m of models) console.log(`${m.id}\t${m.name || ''}`);
      });

    if (argv.length === 0) {
      await this.startInteractive();
      return;
    }
    await program.parseAsync(argv, { from: 'user' });
  }

  isInteractive() {
    return Boolean(process.stdout.isTTY && process.stdin.isTTY);
  }

  async startInteractive() {
    if (this.isInteractive()) {
      await this.startTui();
    } else {
      await this.startRepl();
    }
  }

  async startTui() {
    const { startTui } = await import('./ui/tui.js');
    await startTui({
      cli: this,
      agent: this.agent,
      client: this.client,
      commands: this.commands,
      config: this.config,
    });
  }

  renderEvent(event) {
    if (event.type === 'content') {
      this._streamed = true;
      process.stdout.write(event.text);
    } else if (event.type === 'tool_start') {
      if (this._streamed) { process.stdout.write('\n'); this._streamed = false; }
      process.stdout.write(chalk.cyan(`  ⏺ ${event.name}\n`));
    } else if (event.type === 'tool_end') {
      const out = (event.result?.output || '').split('\n')[0].slice(0, 200);
      process.stdout.write(chalk.gray(`     ⎿ ${out}\n`));
    }
  }

  async runOnce(prompt) {
    this._streamed = false;
    try {
      const res = await this.agent.chat({ message: prompt, sessionId: this.sessionId, onEvent: (e) => this.renderEvent(e) });
      if (this._streamed) process.stdout.write('\n');
      else console.log(res);
    } catch (e) {
      console.error(chalk.red(`Error: ${e.message}`));
      process.exitCode = 1;
    }
  }

  async startRepl() {
    const repl = new Repl({
      cli: this,
      agent: this.agent,
      client: this.client,
      commands: this.commands,
      config: this.config,
    });
    await repl.start();
  }

  async runDoctor() {
    const checks = [];
    checks.push({
      name: 'Node.js',
      ok: Number(process.versions.node.split('.')[0]) >= 18,
      detail: process.version,
    });
    checks.push({
      name: 'Terminal',
      ok: this.isInteractive(),
      detail: this.isInteractive() ? `${this._terminalWidth}x${this._terminalHeight}` : 'non-interactive (REPL fallback will be used)',
    });
    checks.push({
      name: 'Configuration',
      ok: Boolean(this.config.workerUrl),
      detail: this.configSource || 'defaults (run `agent setup` to create a project config)',
    });
    checks.push({
      name: 'Workspace',
      ok: await fs.pathExists(this.cwd),
      detail: this.cwd,
    });

    const health = await this.client.health();
    checks.push({
      name: 'Worker health',
      ok: Boolean(health.ok),
      detail: health.ok ? `HTTP ${health.status}` : health.error || `HTTP ${health.status || 'unreachable'}`,
    });

    const models = health.ok ? await this.client.models() : [];
    checks.push({
      name: 'Models',
      ok: health.ok && models.length > 0,
      detail: models.length ? `${models.length} available` : health.ok ? 'none returned' : 'skipped',
    });

    for (const check of checks) {
      const marker = check.ok ? chalk.green('OK ') : chalk.red('FAIL');
      console.log(`${marker}  ${check.name.padEnd(16)} ${chalk.gray(check.detail)}`);
    }
    if (!health.ok) {
      console.log(chalk.yellow('\nStart the local backend with `npm run dev:worker`, or run `agent setup --worker <deployed-worker-url>`.'));
      process.exitCode = 1;
    }
  }
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
