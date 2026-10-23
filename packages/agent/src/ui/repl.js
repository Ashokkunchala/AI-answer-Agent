import readline from 'node:readline';
import readlineSync from 'readline-sync';
import chalk from 'chalk';

export class Repl {
  constructor(opts) {
    this.cli = opts.cli;
    this.agent = opts.agent;
    this.client = opts.client;
    this.commands = opts.commands;
    this.config = opts.config;
    this.rl = null;
    this.busy = false;
    this.streaming = false;
  }

  renderEvent(event) {
    switch (event.type) {
      case 'content':
        if (!this.streaming) {
          this.streaming = true;
          process.stdout.write('\n');
        }
        process.stdout.write(event.text);
        break;
      case 'reasoning':
        process.stdout.write(chalk.gray(`\n  ✻ ${String(event.text).slice(0, 200)}`));
        break;
      case 'tool_start': {
        if (this.streaming) {
          process.stdout.write('\n');
          this.streaming = false;
        }
        const args = event.args && Object.keys(event.args).length ? chalk.gray(JSON.stringify(event.args).slice(0, 160)) : '';
        process.stdout.write(chalk.cyan(`  ⏺ ${event.name}`) + (args ? ' ' + args : '') + '\n');
        break;
      }
      case 'tool_end': {
        const diff = event.result?.metadata?.diff;
        if (Array.isArray(diff) && diff.length) {
          for (const line of diff.slice(0, 20)) {
            const text = String(line.text).slice(0, 160);
            if (line.type === 'add') process.stdout.write(chalk.green(`     + ${text}\n`));
            else if (line.type === 'del') process.stdout.write(chalk.red(`     - ${text}\n`));
            else process.stdout.write(chalk.gray(`       ${text}\n`));
          }
        } else {
          const out = (event.result?.output || '').split('\n').slice(0, 4).join('\n     ');
          process.stdout.write(chalk.gray(`     ⎿ ${out || '(no output)'}\n`));
        }
        break;
      }
      case 'warning':
        process.stdout.write(chalk.yellow(`\n  ! ${event.text}\n`));
        break;
      case 'error':
        process.stdout.write(chalk.red(`\n  ✗ ${event.text}\n`));
        break;
      default:
        break;
    }
  }

  // Interactive permission prompt for the REPL. Returns allow|always|deny.
  requestPermission(request) {
    if (this.streaming) {
      process.stdout.write('\n');
      this.streaming = false;
    }
    console.log(chalk.yellow(`\nPermission required: ${request.name}${request.reason ? ` (${request.reason})` : ''}`));
    for (const line of request.preview?.lines?.slice(0, 12) || []) console.log(chalk.gray(`  ${line}`));
    const answer = readlineSync.question('  allow? [y]es / [a]lways / [n]o: ', { defaultInput: 'n' });
    const first = String(answer).trim().toLowerCase();
    if (first.startsWith('a')) return 'always';
    if (first.startsWith('y')) return 'allow';
    return 'deny';
  }

  async handleLine(line) {
    const input = line.trim();
    if (!input) return;
    if (this.busy) {
      console.log(chalk.yellow('Busy — please wait for the current turn to finish.'));
      return;
    }

    if (input.startsWith('/')) {
      const result = await this.commands.handle(input);
      if (result === 'exit') {
        this.rl.close();
        return;
      }
      if (result && typeof result === 'object' && result.prompt) return this.runPrompt(result.prompt);
      return;
    }
    return this.runPrompt(input);
  }

  async runPrompt(input) {
    this.busy = true;
    this.streaming = false;
    try {
      await this.agent.chat({
        message: input,
        sessionId: this.cli.sessionId,
        onEvent: (e) => this.renderEvent(e),
        onPermission: (request) => this.requestPermission(request),
      });
      if (this.streaming) {
        process.stdout.write('\n');
        this.streaming = false;
      }
    } catch (e) {
      console.error(chalk.red(`\nError: ${e.message}`));
    } finally {
      this.busy = false;
    }
  }

  async start() {
    const url = this.config?.workerUrl || '(not set)';
    console.log(chalk.cyan.bold('agent terminal') + chalk.gray(' — personal coding workbench'));
    console.log(chalk.gray(`worker: ${url}   model: ${this.config?.model || 'auto'}   tools: ${this.config?.tools !== false ? 'on' : 'off'}`));
    console.log(chalk.gray('Type /help for commands, /exit to quit.'));

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.green('agent> '),
    });

    this.rl.prompt();
    this.rl.on('line', async (line) => {
      try {
        await this.handleLine(line);
      } catch (e) {
        console.error(chalk.red(`Error: ${e.message}`));
      }
      if (!this.rl.closed) this.rl.prompt();
    });
    this.rl.on('close', () => {
      console.log(chalk.gray('\nBye'));
      process.exit(0);
    });
  }
}
