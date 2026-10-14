import chalk from 'chalk';
import { randomUUID } from 'node:crypto';

const HELP = [
  ['/help', 'Show this help'],
  ['/tools', 'List available agent tools'],
  ['/model [name]', 'Show or set the model (use "auto" for worker routing)'],
  ['/models', 'List models available on the worker'],
  ['/cwd [path]', 'Show or change the working directory'],
  ['/clear', 'Start a fresh conversation'],
  ['/config', 'Show current config'],
  ['/set key=value', 'Set and save a config value'],
  ['/permissions [on|off]', 'Show or toggle automatic approval for edits and shell commands'],
  ['/doctor', 'Check terminal and Worker connectivity'],
  ['/health', 'Check worker health'],
  ['/session', 'Create a worker interview session'],
  ['/context <id>', 'Show session context'],
  ['/finalize <id>', 'Finalize an interview session'],
  ['/report <id>', 'Get an interview report'],
  ['/exit', 'Quit'],
];

export class CommandRegistry {
  constructor(opts) {
    this.cli = opts.cli;
    this.client = opts.client;
    this.agent = opts.agent;
    this.configLoader = opts.configLoader;
  }

  printHelp() {
    console.log(chalk.yellow('Commands:'));
    const width = Math.max(...HELP.map((h) => h[0].length));
    for (const [cmd, desc] of HELP) console.log(`  ${chalk.green(cmd.padEnd(width))}  ${chalk.gray(desc)}`);
  }

  async handle(line) {
    const [cmd, ...rest] = line.slice(1).split(/\s+/);
    const args = rest.join(' ').trim();

    switch (cmd) {
      case 'help':
        this.printHelp();
        return true;

      case 'tools': {
        const names = this.agent.registry.list();
        console.log(chalk.yellow(`Tools (${names.length}, ${this.cli.config.tools !== false ? 'enabled' : 'disabled'}):`));
        for (const t of this.agent.registry.list()) {
          const tool = this.agent.registry.get(t);
          console.log(`  ${chalk.green(t)}  ${chalk.gray(tool.description || '')}`);
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
        console.log(chalk.green(`cwd set to ${this.agent.cwd}`));
        return true;
      }

      case 'clear':
      case 'new': {
        this.agent.resetSession(this.cli.sessionId);
        this.cli.sessionId = randomUUID();
        console.log(chalk.green('Started a new conversation.'));
        return true;
      }

      case 'config':
        console.log(JSON.stringify(this.cli.config, null, 2));
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
        if (args === 'on') this.cli.config.autoApprove = true;
        else if (args === 'off') this.cli.config.autoApprove = false;
        else if (args) { console.log('Usage: /permissions [on|off]'); return true; }
        if (args) {
          const p = await this.configLoader.save(this.cli.config);
          this.agent.setConfig(this.cli.config);
          console.log(chalk.green(`Automatic approval ${this.cli.config.autoApprove ? 'enabled' : 'disabled'} (saved to ${p})`));
        } else {
          console.log(`automatic approval: ${this.cli.config.autoApprove ? chalk.green('on') : chalk.yellow('off')}`);
        }
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

      case 'session': {
        const s = await this.client.createSession({ candidateName: 'CLI', roleTitle: 'DevOps Engineer' });
        console.log(s || chalk.gray('(no response)'));
        return true;
      }

      case 'context': {
        if (!args) { console.log('Usage: /context <sessionId>'); return true; }
        console.log(JSON.stringify(await this.client.getContext(args), null, 2));
        return true;
      }

      case 'finalize': {
        if (!args) { console.log('Usage: /finalize <sessionId>'); return true; }
        console.log(await this.client.finalize(args));
        return true;
      }

      case 'report': {
        if (!args) { console.log('Usage: /report <sessionId>'); return true; }
        console.log(JSON.stringify(await this.client.report(args), null, 2));
        return true;
      }

      case 'exit':
      case 'quit':
        return 'exit';

      default:
        console.log(chalk.red(`Unknown command: ${cmd}. Try /help.`));
        return true;
    }
  }
}

function coerce(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}
