import chalk from 'chalk';
import { randomUUID } from 'node:crypto';
import { CustomCommands } from './custom.js';
import { redactConfig } from '../config/loader.js';

const HELP = [
  ['/help', 'Show this help'],
  ['/tools', 'List available agent tools'],
  ['/model [name]', 'Show or set the model (use "auto" for worker routing)'],
  ['/models', 'List models available on the worker'],
  ['/cwd [path]', 'Show or change the working directory'],
  ['/clear', 'Start a fresh conversation'],
  ['/compact', 'Summarize and trim the conversation history'],
  ['/config', 'Show current config'],
  ['/set key=value', 'Set and save a config value'],
  ['/permissions [allow|ask|deny]', 'Show or set the permission mode'],
  ['/undo', 'Revert the last file edit (checkpoint)'],
  ['/redo', 'Re-apply the last reverted edit'],
  ['/rewind [n]', 'Revert the last n edits'],
  ['/checkpoints', 'List file checkpoints for this session'],
  ['/skills [name]', 'List skills or show one'],
  ['/subagents', 'List available sub-agent types'],
  ['/sessions', 'List saved sessions'],
  ['/session export <id>', 'Export a session to JSON file'],
  ['/session import <file>', 'Import a session from JSON file'],
  ['/branch', 'Fork this conversation into a new session'],
  ['/init', 'Create an AGENTS.md scaffold for this project'],
  ['/doctor', 'Check terminal and Worker connectivity'],
  ['/health', 'Check worker health'],
  ['/worker [setup|routing]', 'Live worker status: usage, cost, routing, setup'],
  ['/route <text>', 'Preview which model the worker would route a prompt to'],
  ['/keys [create <name>|revoke <id>]', 'List, create or revoke worker API keys'],
  ['/debug [on|off]', 'Toggle debug logging'],
  ['/exit', 'Quit'],
];

export class CommandRegistry {
  constructor(opts) {
    this.cli = opts.cli;
    this.client = opts.client;
    this.agent = opts.agent;
    this.configLoader = opts.configLoader;
    this.custom = new CustomCommands({ cwd: this.agent?.cwd, enabled: opts.cli?.config?.customCommands !== false });
  }

  async printHelp() {
    console.log(chalk.yellow('Commands:'));
    const width = Math.max(...HELP.map((h) => h[0].length));
    for (const [cmd, desc] of HELP) console.log(`  ${chalk.green(cmd.padEnd(width))}  ${chalk.gray(desc)}`);
    const custom = await this.custom.list();
    if (custom.length) {
      console.log(chalk.yellow('\nCustom commands:'));
      for (const c of custom) console.log(`  ${chalk.green(`/${c.name}`.padEnd(width))}  ${chalk.gray(c.description || '')}`);
    }
  }

  // Names + descriptions for the command palette.
  async names() {
    const custom = await this.custom.list();
    return [
      ...HELP.map(([name, description]) => ({ name, description })),
      ...custom.map((c) => ({ name: `/${c.name}`, description: c.description })),
    ];
  }

  // Returns true (handled), 'exit', or { prompt } to run through the agent.
  async handle(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const args = rest.join(' ').trim();

    switch (cmd) {
      case 'help':
        await this.printHelp();
        return true;

      case 'tools': {
        const tools = this.agent.registry.describe();
        console.log(chalk.yellow(`Tools (${tools.length}, ${this.cli.config.tools !== false ? 'enabled' : 'disabled'}):`));
        for (const t of tools) {
          const flags = [t.category, t.mutating ? 'mutating' : null].filter(Boolean).join(', ');
          console.log(`  ${chalk.green(t.name.padEnd(12))} ${chalk.gray(`[${flags}]`)} ${chalk.gray(t.description || '')}`);
        }
        return true;
      }

      case 'model': {
        if (!args) {
          console.log(`model: ${chalk.green(this.cli.config.model || 'auto')}`);
          return true;
        }
        this.cli.config.model = args;
        this.client.setConfig(this.cli.config);
        this.agent.setConfig(this.cli.config);
        await this.configLoader.save(this.cli.config);
        console.log(chalk.green(`model set to ${args}`));
        return true;
      }

      case 'models': {
        const models = await this.client.models();
        if (!models.length) {
          console.log(chalk.gray('No models returned (is the worker running and /v1/models reachable?)'));
          return true;
        }
        for (const m of models) console.log(`  ${chalk.green(m.id.padEnd(26))} ${chalk.gray(m.name || '')}`);
        return true;
      }

      case 'cwd': {
        if (!args) {
          console.log(`cwd: ${this.agent.cwd}`);
          return true;
        }
        this.agent.setCwd(args);
        this.custom.setCwd(this.agent.cwd);
        console.log(chalk.green(`cwd set to ${this.agent.cwd}`));
        return true;
      }

      case 'clear':
      case 'new': {
        this.agent.resetSession(this.cli.sessionId);
        this.cli.sessionId = randomUUID();
        this.agent.permissions.resetSession();
        console.log(chalk.green('Started a new conversation.'));
        return true;
      }

      case 'compact': {
        const sess = this.agent.getOrCreateSession(this.cli.sessionId);
        const before = sess.messages.length;
        sess.messages = sess.messages.slice(-Math.floor(before / 2));
        console.log(chalk.green(`Trimmed conversation history from ${before} to ${sess.messages.length} messages.`));
        return true;
      }

      case 'config':
        console.log(JSON.stringify(redactConfig(this.cli.config), null, 2));
        return true;

      case 'set': {
        const [k, ...vparts] = args.split('=');
        const v = vparts.join('=');
        if (!k) { console.log('Usage: /set key=value'); return true; }
        this.cli.config[k] = coerce(v);
        const p = await this.configLoader.save(this.cli.config);
        this.client.setConfig(this.cli.config);
        this.agent.setConfig(this.cli.config);
        console.log(chalk.green(`Saved to ${p}`));
        return true;
      }

      case 'permissions': {
        if (['allow', 'ask', 'deny'].includes(args)) {
          this.cli.config.permissionMode = args;
          delete this.cli.config.autoApprove;
          const p = await this.configLoader.save(this.cli.config);
          this.agent.setConfig(this.cli.config);
          console.log(chalk.green(`Permission mode set to ${args} (saved to ${p})`));
        } else {
          console.log(`permission mode: ${chalk.green(this.agent.permissions.mode())}`);
          console.log(chalk.gray('  /permissions allow | ask | deny'));
        }
        return true;
      }

      case 'undo': {
        const cp = await this.agent.checkpoints.undo(this.cli.sessionId);
        console.log(cp ? chalk.green(`Reverted: ${cp.label} (${cp.paths.length} file(s))`) : chalk.gray('Nothing to undo.'));
        return true;
      }

      case 'redo': {
        const cp = await this.agent.checkpoints.redo(this.cli.sessionId);
        console.log(cp ? chalk.green(`Re-applied: ${cp.label}`) : chalk.gray('Nothing to redo.'));
        return true;
      }

      case 'rewind': {
        const n = Number(args) || 1;
        const applied = await this.agent.checkpoints.rewind(this.cli.sessionId, n);
        console.log(applied.length ? chalk.green(`Reverted ${applied.length} checkpoint(s).`) : chalk.gray('Nothing to rewind.'));
        return true;
      }

      case 'checkpoints': {
        const list = await this.agent.checkpoints.list(this.cli.sessionId);
        if (!list.length) { console.log(chalk.gray('No checkpoints yet.')); return true; }
        for (const c of list) console.log(`  ${chalk.green(c.id)}  ${chalk.gray(c.ts)}  ${c.label}  ${chalk.gray(c.paths.join(', '))}`);
        return true;
      }

      case 'skills': {
        if (args) {
          const skill = await this.agent.skills.load(args);
          if (!skill) { console.log(chalk.red(`Unknown skill "${args}".`)); return true; }
          console.log(chalk.cyan(`# ${skill.name}`));
          console.log(skill.body);
          return true;
        }
        const skills = await this.agent.skills.list();
        if (!skills.length) { console.log(chalk.gray('No skills found (.agent/skills).')); return true; }
        for (const s of skills) console.log(`  ${chalk.green(s.name)}  ${chalk.gray(s.description || '')}`);
        return true;
      }

      case 'subagents': {
        for (const s of this.agent.subagents.list()) console.log(`  ${chalk.green(s.name.padEnd(10))} ${chalk.gray(s.description)}`);
        return true;
      }

      case 'sessions': {
        const list = await this.cli.sessionStore?.list?.() || [];
        if (!list.length) { console.log(chalk.gray('No saved sessions.')); return true; }
        for (const s of list) console.log(`  ${chalk.green(s.id)}  ${chalk.gray(s.updatedAt)}  ${chalk.cyan(`${s.turns} turn(s)`)}  ${s.title}`);
        return true;
      }

      case 'session': {
        const sub = rest[0]?.toLowerCase();
        if (sub === 'export') {
          return this.exportSession(rest[1]);
        }
        if (sub === 'import') {
          return this.importSession(rest[1]);
        }
        console.log(chalk.gray('Usage: /session export <id> | /session import <file>'));
        return true;
      }

      case 'branch': {
        if (!this.cli.sessionStore) { console.log(chalk.gray('Session store unavailable.')); return true; }
        const newId = randomUUID();
        await this.cli.sessionStore.save({
          id: this.cli.sessionId,
          title: this.agent.getOrCreateSession(this.cli.sessionId).title,
          cwd: this.agent.cwd,
          messages: this.agent.getOrCreateSession(this.cli.sessionId).messages,
        });
        const forked = await this.cli.sessionStore.fork(this.cli.sessionId, newId);
        if (!forked) { console.log(chalk.red('Cannot branch: session not saved yet.')); return true; }
        this.cli.sessionId = newId;
        this.agent.resetSession(newId);
        console.log(chalk.green(`Branched into new session ${newId}.`));
        return true;
      }

      case 'init': {
        const fs = (await import('fs-extra')).default;
        const path = (await import('node:path')).default;
        const target = path.join(this.agent.cwd, 'AGENTS.md');
        if (await fs.pathExists(target)) { console.log(chalk.yellow('AGENTS.md already exists.')); return true; }
        await fs.writeFile(target, '# Project instructions\n\nDescribe build/test commands and conventions for this project.\n', 'utf8');
        console.log(chalk.green(`Created ${target}`));
        return true;
      }

      case 'doctor':
        await this.cli.runDoctor();
        return true;

      case 'health': {
        const h = await this.client.health();
        console.log(h.ok ? chalk.green(`healthy (HTTP ${h.status})`) : chalk.red(JSON.stringify(h)));
        return true;
      }

      case 'worker':
        return this.workerStatus(args);

      case 'route':
        return this.routePreview(args);

      case 'keys':
        return this.keys(args, rest);

      case 'debug': {
        const sub = rest[0]?.toLowerCase();
        if (sub === 'on' || sub === 'true' || sub === '1' || sub === 'yes') {
          process.env.DEBUG = '*';
          console.log(chalk.green('Debug logging enabled'));
        } else if (sub === 'off' || sub === 'false' || sub === '0' || sub === 'no') {
          delete process.env.DEBUG;
          console.log(chalk.green('Debug logging disabled'));
        } else {
          console.log(`Debug logging: ${process.env.DEBUG ? chalk.green('on') : chalk.gray('off')}`);
          console.log(chalk.gray('  /debug on | off'));
        }
        return true;
      }

      case 'exit':
      case 'quit':
        return 'exit';

      default: {
        const custom = await this.custom.expand(cmd, args);
        if (custom) return { prompt: custom.prompt };
        console.log(chalk.red(`Unknown command: ${cmd}. Try /help.`));
        return true;
      }
    }
  }

  // /session export <id> - export a session to a JSON file
  async exportSession(id) {
    if (!id) { console.log(chalk.gray('Usage: /session export <id>')); return true; }
    if (!this.cli.sessionStore) { console.log(chalk.gray('Session store unavailable.')); return true; }
    const session = await this.cli.sessionStore.load(id);
    if (!session) { console.log(chalk.red(`Session ${id} not found.`)); return true; }
    const fs = (await import('fs-extra')).default;
    const path = (await import('node:path')).default;
    const file = path.join(process.cwd(), `session-${encodeURIComponent(String(id))}.json`);
    await fs.writeJson(file, session, { spaces: 2 });
    console.log(chalk.green(`Exported session ${id} to ${file}`));
    return true;
  }

  // /session import <file> - import a session from a JSON file
  async importSession(filePath) {
    if (!filePath) { console.log(chalk.gray('Usage: /session import <file>')); return true; }
    if (!this.cli.sessionStore) { console.log(chalk.gray('Session store unavailable.')); return true; }
    const fs = (await import('fs-extra')).default;
    const path = (await import('node:path')).default;
    const fullPath = path.resolve(filePath);
    if (!(await fs.pathExists(fullPath))) { console.log(chalk.red(`File not found: ${fullPath}`)); return true; }
    try {
      const session = await fs.readJson(fullPath);
      if (!session.id || !session.messages) { console.log(chalk.red('Invalid session file.')); return true; }
      await this.cli.sessionStore.save(session);
      console.log(chalk.green(`Imported session ${session.id} (${session.messages.length} messages)`));
    } catch (e) {
      console.log(chalk.red(`Failed to import: ${e.message}`));
    }
    return true;
  }

  // /worker [setup|routing] - live view of the shared worker: health, usage,
  // cost, routing policy and setup. Falls back to /health when /v1/status is absent.
  async workerStatus(args) {
    const s = await this.client.status();
    if (!s) {
      const health = await this.client.health();
      console.log(chalk.red('Worker status unavailable (GET /v1/status).'));
      if (health?.ok) console.log(chalk.gray(`Worker /health is up (HTTP ${health.status}) - redeploy for /v1/status.`));
      else console.log(chalk.red(health?.error || 'Worker unreachable.'));
      return true;
    }
    const setup = s.setup || {};
    const budget = s.budget || {};
    const usage = s.usage || {};
    const usd = (n, digits = 4) => '$' + Number(n || 0).toFixed(digits);
    const counts = (u) => `${u.requests || 0} req / ${u.neurons || 0} neurons / ${usd(u.usd)}`;

    if (args === 'setup') {
      console.log(chalk.yellow('Worker setup'));
      for (const [key, value] of Object.entries(setup.env_vars || {})) {
        console.log(`  ${chalk.green(String(key).padEnd(20))} ${value}`);
      }
      console.log(`  ${chalk.green('key format'.padEnd(20))} ${setup.key_format || ''}`);
      console.log(`  ${chalk.green('public paths'.padEnd(20))} ${(setup.public_paths || []).join(', ')}`);
      console.log(chalk.yellow('\nEndpoints'));
      for (const [path, desc] of Object.entries(setup.endpoints || {})) {
        console.log(`  ${chalk.green(path.padEnd(28))} ${chalk.gray(desc)}`);
      }
      return true;
    }

    if (args === 'routing') {
      console.log(chalk.yellow(`Routing policy: ${s.routing?.policy || ''}`));
      console.log(chalk.gray(`Free-pool fallbacks: ${(s.free_pool_models || []).join(', ')}`));
      for (const task of s.routing?.tasks || []) {
        console.log(chalk.cyan(`\n${task.label || task.id}`));
        (task.chain || []).forEach((hop, index) => {
          const tag = hop.kind === 'pool' ? chalk.green(' [free]') : '';
          console.log(`  ${index + 1}. ${hop.model}${tag} ${chalk.gray(hop.reason || '')}`);
        });
      }
      return true;
    }

    console.log(`${chalk.yellow('Worker')} ${chalk.green(s.status || 'unknown')} ${chalk.gray(`v${s.version || '?'} (${s.environment || 'development'})`)}`);
    console.log(`  ${chalk.green('url'.padEnd(10))} ${setup.worker_url || this.client.workerUrl}`);
    console.log(`  ${chalk.green('models'.padEnd(10))} ${s.models_count || 0} (free pool: ${(s.free_pool_models || []).length})`);
    console.log(`  ${chalk.green('budget'.padEnd(10))} ${String(budget.mode || 'free').toUpperCase()} / ${budget.neurons_today || 0} of ${budget.free_neurons_per_day || 0} neurons today / ${usd(budget.usd_month)} of ${usd(budget.budget_monthly_usd, 2)} (saver at ${usd(budget.saver_at_usd, 2)})`);
    console.log(`  ${chalk.green('today'.padEnd(10))} ${counts(usage.today || {})}`);
    console.log(`  ${chalk.green('month'.padEnd(10))} ${counts(usage.this_month || {})}`);
    console.log(`  ${chalk.green('pool'.padEnd(10))} ${(s.free_pool_models || []).join(' ')}`);
    if (setup.dashboard_url) console.log(`  ${chalk.green('dashboard'.padEnd(10))} ${chalk.cyan(setup.dashboard_url)}`);
    if (this.client.apiKey) console.log(`  ${chalk.green('api key'.padEnd(10))} set (${maskKey(this.client.apiKey)}) - /keys to list`);
    else console.log(`  ${chalk.green('api key'.padEnd(10))} ${chalk.gray('not set - /set apiKey=dvops_... unlocks /v1/usage, /route and /keys')}`);
    console.log(chalk.gray('  /worker setup | /worker routing | /route <text> | /keys'));
    return true;
  }

  // /route <text> - preview the task type + model chain the worker would pick.
  async routePreview(text) {
    if (!text) {
      console.log(chalk.gray('Usage: /route <text>'));
      return true;
    }
    const preview = await this.client.route(text);
    if (preview) {
      console.log(`${chalk.yellow('task')}  ${chalk.cyan(preview.task_label || preview.task_type || 'unknown')}`);
      (preview.chain || []).forEach((hop, index) => {
        const tag = hop.kind === 'pool' ? chalk.green(' [free]') : '';
        console.log(`  ${index + 1}. ${hop.model}${tag} ${chalk.gray(hop.reason || '')}`);
      });
      return true;
    }
    console.log(chalk.gray('Prompt preview needs an API key - showing the static routing table instead.'));
    const s = await this.client.status();
    for (const task of s?.routing?.tasks || []) {
      console.log(chalk.cyan(`\n${task.label || task.id}`));
      (task.chain || []).slice(0, 4).forEach((hop, index) => {
        const tag = hop.kind === 'pool' ? chalk.green(' [free]') : '';
        console.log(`  ${index + 1}. ${hop.model}${tag} ${chalk.gray(hop.reason || '')}`);
      });
    }
    return true;
  }

  // /keys [create <name> | revoke <id>] - manage worker API keys.
  async keys(args, rest) {
    const sub = (rest?.[0] || '').toLowerCase();
    try {
      if (sub === 'create' || sub === 'new') {
        const name = rest.slice(1).join(' ') || 'agent-cli';
        const created = await this.client.createKey({ name });
        console.log(chalk.green(`Created key "${created.name || name}" (id ${created.id})`));
        console.log(`  ${chalk.yellow('key')} ${created.key}`);
        console.log(chalk.gray(`  Copy it now - it is shown once. Add it with: /set apiKey=${created.key}`));
        return true;
      }
      if (sub === 'revoke') {
        const id = rest[1];
        if (!id) { console.log(chalk.gray('Usage: /keys revoke <id>')); return true; }
        const result = await this.client.revokeKey(id);
        console.log(result?.success ? chalk.green(`Revoked ${id}`) : chalk.red(result?.error || 'Revoke failed'));
        return true;
      }
      const keys = await this.client.listKeys();
      if (keys === null) {
        console.log(chalk.gray('Listing keys needs an API key: /set apiKey=dvops_... (create one with /keys create <name>)'));
        return true;
      }
      if (!keys.length) { console.log(chalk.gray('No keys yet. Create one with: /keys create <name>')); return true; }
      for (const key of keys) {
        const status = key.revoked ? chalk.red('revoked') : chalk.green('active');
        console.log(`  ${chalk.cyan(String(key.id).padEnd(12))} ${String(key.name).padEnd(16)} ${status} ${chalk.gray(`${key.tier} / ${key.key_preview} / ${key.today_usage?.requests || 0} req today`)}`);
      }
      return true;
    } catch (error) {
      console.log(chalk.red(error.message));
      return true;
    }
  }
}

function maskKey(key) {
  const value = String(key || '');
  return value.length > 14 ? `${value.slice(0, 10)}...${value.slice(-4)}` : value;
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
