import readline from 'node:readline';
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
        const out = (event.result?.output || '').split('\n').slice(0, 3).join('\n     ');
        process.stdout.write(chalk.gray(`     ⎿ ${out || '(no output)'}\n`));
        break;
      }
      default:
        break;
    }
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
      return;
    }

    this.busy = true;
    this.streaming = false;
    try {
      await this.agent.chat({ message: input, sessionId: this.cli.sessionId, onEvent: (e) => this.renderEvent(e) });
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
    console.log(chalk.cyan.bold('agent') + chalk.gray(' — local coding agent (opencode-style)'));
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
