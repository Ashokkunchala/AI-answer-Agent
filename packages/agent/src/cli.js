import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import readlineSync from 'readline-sync';
import { ConfigLoader, redactConfig } from './config/loader.js';
import { ProviderClient } from './client/provider-client.js';
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
    this.client = new ProviderClient();
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
      } catch (e) {
        console.debug?.(`Cleanup error: ${e.message}`);
      }
      return origExit(code);
    };
  }

  async initConfig() {
    const { config, source } = await this.configLoader.load();
    if (!config.apiKey) config.apiKey = await this.configLoader.loadGlobalApiKey();
    this.config = config;
    this.configSource = source;
    if (config.provider === 'worker' && !config.workerUrl) config.workerUrl = 'https://devops-ai-agent.ashokkunchla.workers.dev';
    if (config.cwd) {
      this.agent.setCwd(config.cwd);
    }
    this.sessionStore = new SessionStore({ dir: config.sessionsDir });
    this.agent.setSessionStore(this.sessionStore);
    this.client.setConfig(config);
    this.agent.setConfig(config);
  }

  // Render the onPermission prompt for non-interactive one-shot runs.
  // Interactive terminals are prompted via readline; piped/non-TTY runs are
  // denied unless auto-approved in config or `--yes` was passed.
  onPermission(request) {
    if (this._yes) return 'allow';
    if (this.config?.autoApprove === true || this.config?.permissionMode === 'allow') return 'allow';
    if (this.isInteractive()) {
      const preview = request?.preview?.lines?.slice(0, 12).join('\n  ') || '';
      const answer = readlineSync.question(`${chalk.yellow('Permission required')}: ${request.name}${preview ? `\n  ${preview}` : ''}\n  allow? [y]es / [a]lways / [n]o: `, { defaultInput: 'n' });
      const first = String(answer).trim().toLowerCase();
      if (first.startsWith('a')) return 'always';
      if (first.startsWith('y')) return 'allow';
      return 'deny';
    }
    return 'deny';
  }

  async run(argv) {
    if (!this.config) await this.initConfig();
    const program = new Command();
    const binName = basename(process.argv[1] || 'agent').replace(/\.(js|mjs|cjs)$/, '');
    program.name(binName).description('Standalone coding agent terminal connected to your Cloudflare Worker').version(pkg.version);

    program
      .command('run <prompt...>')
      .description('Run a single prompt through the full agentic tool loop')
      .option('-y, --yes', 'auto-approve mutating tool calls')
      .action(async (promptParts, opts) => {
        this._yes = Boolean(opts.yes);
        const prompt = promptParts.join(' ');
        await this.runOnce(prompt);
      });

    program
      .command('chat [message...]')
      .description('Chat once, or open the interactive terminal UI when no message is given')
      .option('-s, --session <id>', 'session id')
      .option('-y, --yes', 'auto-approve mutating tool calls')
      .action(async (messageParts, opts) => {
        if (!messageParts || !messageParts.length) {
          await this.startInteractive();
          return;
        }
        this._yes = Boolean(opts.yes);
        const sessionId = opts.session || this.sessionId;
        this._streamed = false;
        const onEvent = (e) => this.renderEvent(e);
        const res = await this.agent.chat({ message: messageParts.join(' '), sessionId, onEvent, onPermission: (r) => this.onPermission(r) });
        if (!this._streamed) console.log(res);
      });

    program
      .command('tui')
      .description('Open the compact classic TUI')
      .action(async () => {
        await this.startTui();
      });

    program
      .command('ui')
      .description('Open the standalone full-screen agent terminal')
      .option('--classic', 'open the classic personal terminal instead')
      .action(async (opts) => {
        if (opts.classic) return this.startClassicTerminal();
        await this.startTerminal();
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
        console.log(JSON.stringify(redactConfig(this.config), null, 2));
      });

    program
      .command('setup')
      .description('Configure the Cloudflare Worker or Gemini API provider')
      .option('--provider <name>', 'model provider: worker | gemini')
      .option('--worker <url>', 'Worker base URL')
      .option('--gemini-url <url>', 'Gemini OpenAI-compatible API base URL')
      .option('--model <name>', 'model id, or "auto"')
      .option('--api-key <key>', 'Worker API key')
      .option('--no-tools', 'disable local tools')
      .option('--approve', 'auto-approve mutating tool calls')
      .option('--permission <mode>', 'permission mode: allow | ask | deny')
      .option('--no-check', 'skip automatic post-edit checks')
      .option('-g, --global', 'write to the user-global config (applies to every project)')
      .action(async (opts) => {
        const next = { ...this.config };
        if (opts.provider) next.provider = opts.provider;
        if (opts.worker) { next.workerUrl = opts.worker; next.provider = 'worker'; }
        if (opts.geminiUrl) { next.geminiUrl = opts.geminiUrl; next.provider = 'gemini'; }
        if (opts.model) next.model = opts.model;
        if (opts.apiKey) next.apiKey = opts.apiKey;
        if (opts.tools === false) next.tools = false;
        if (opts.approve) next.autoApprove = true;
        if (opts.permission) { next.permissionMode = opts.permission; delete next.autoApprove; }
        if (opts.check === false) next.autoCheck = false;
        const target = opts.global
          ? await this.configLoader.save(next, this.configLoader.globalConfigPath())
          : await this.configLoader.save(next);
        this.config = next;
        this.client.setConfig(next);
        this.agent.setConfig(next);
        console.log(chalk.green(`${opts.global ? 'Configured agent globally' : 'Configured agent for this project'}: ${target}`));
        console.log(chalk.gray(`provider: ${next.provider}  model: ${next.model || 'choose a model'}  tools: ${next.tools !== false ? 'on' : 'off'}`));
        if (opts.apiKey) console.log(chalk.yellow('The API key is saved in your user/project config. Prefer GEMINI_API_KEY or the provider environment variable to keep credentials out of config files.'));
        console.log(chalk.gray('Run ' + binName + ' doctor to verify the provider, then ' + binName + ' to start the terminal.'));
      });

    program
      .command('doctor')
      .description('Check terminal, project, configuration, and model provider connectivity')
      .action(async () => {
        await this.runDoctor();
      });

    program
      .command('health')
      .description('Check model provider health')
      .action(async () => {
        console.log(await this.client.health());
      });

    program
      .command('models')
      .description('List models available from the configured provider')
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
      await this.startTerminal();
    } else {
      await this.startRepl();
    }
  }

  async startTerminal() {
    // Ink needs a TTY (raw mode). In pipes/CI fall back to the line REPL
    // instead of crashing with Ink's raw-mode error.
    if (!this.isInteractive()) {
      console.log(chalk.yellow('No TTY detected — falling back to the line REPL.'));
      return this.startRepl();
    }
    if (this.config?.provider === 'worker' && !this.client.apiKey) {
      const key = readlineSync.question(chalk.cyan('Worker API key: '), { hideEchoBack: true, mask: '*' }).trim();
      if (!key) {
        console.error(chalk.red('A Worker API key is required. Set WORKER_API_KEY or run `agent setup --api-key <key>`.'));
        process.exitCode = 1;
        return;
      }
      this.config.apiKey = key;
      this.client.setConfig(this.config);
      const target = await this.configLoader.saveGlobalApiKey(key);
      console.log(chalk.gray(`Worker key saved to your user config: ${target}`));
    }
    try {
      const { startNeoTerminal } = await import('./ui/neo.js');
      await startNeoTerminal({
        cli: this,
        agent: this.agent,
        client: this.client,
        commands: this.commands,
        config: this.config,
        moduleName: 'agent-terminal',
      });
      return;
    } catch (error) {
      console.log(chalk.yellow(`Neo terminal unavailable (${error.message}) — using the classic terminal.`));
    }
    await this.startClassicTerminal();
  }

  async startClassicTerminal() {
    if (!this.isInteractive()) {
      console.log(chalk.yellow('No TTY detected — falling back to the line REPL.'));
      return this.startRepl();
    }
    const { startTerminal } = await import('./ui/terminal.js');
    await startTerminal({
      cli: this,
      agent: this.agent,
      client: this.client,
      commands: this.commands,
      config: this.config,
      moduleName: 'agent-terminal',
    });
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
    } else if (event.type === 'reasoning') {
      process.stdout.write(chalk.gray(`\n  ✻ ${String(event.text).slice(0, 200)}`));
    } else if (event.type === 'tool_start') {
      if (this._streamed) { process.stdout.write('\n'); this._streamed = false; }
      process.stdout.write(chalk.cyan(`  ⏺ ${event.name}${event.scope ? chalk.gray(` [${event.scope}]`) : ''}\n`));
    } else if (event.type === 'tool_end') {
      const diff = event.result?.metadata?.diff;
      if (Array.isArray(diff) && diff.length) {
        for (const line of diff.slice(0, 20)) {
          const text = String(line.text).slice(0, 160);
          if (line.type === 'add') process.stdout.write(chalk.green(`     + ${text}\n`));
          else if (line.type === 'del') process.stdout.write(chalk.red(`     - ${text}\n`));
          else process.stdout.write(chalk.gray(`       ${text}\n`));
        }
      } else {
        const out = (event.result?.output || '').split('\n')[0].slice(0, 200);
        process.stdout.write(chalk.gray(`     ⎿ ${out}\n`));
      }
    } else if (event.type === 'warning') {
      process.stdout.write(chalk.yellow(`\n  ! ${event.text}\n`));
    } else if (event.type === 'error') {
      process.stdout.write(chalk.red(`\n  ✗ ${event.text}\n`));
    }
  }

  async runOnce(prompt) {
    this._streamed = false;
    try {
      const res = await this.agent.chat({ message: prompt, sessionId: this.sessionId, onEvent: (e) => this.renderEvent(e), onPermission: (r) => this.onPermission(r) });
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
      ok: this.client.configured,
      detail: this.configSource || 'defaults (run `agent setup` to create a project config)',
    });
    checks.push({
      name: 'Workspace',
      ok: await fs.pathExists(this.cwd),
      detail: this.cwd,
    });

    const health = await this.client.health();
    checks.push({
      name: `${this.config.provider || 'worker'} health`,
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
      console.log(chalk.yellow('\nStart the local backend with `npm run dev:worker`, or configure a deployed Worker with `agent setup --worker <url> --api-key <key>`.'));
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
