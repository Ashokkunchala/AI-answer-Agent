import { spawn } from 'node:child_process';
import { defineTool } from './define-tool.js';

const MAX_OUTPUT = 30000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n… [truncated ${text.length - MAX_OUTPUT} chars]`;
}

export class ShellTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.lastCwd = this.cwd;
  }

  get tools() {
    const bash = defineTool({
      name: 'bash',
      description:
        'Execute a shell command in the workspace. On Windows commands run via cmd.exe; elsewhere via /bin/sh -c.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          description: { type: 'string', description: 'Short description of what the command does' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
        },
        required: ['command'],
      },
      execute: ({ command, timeout = 120000 }) => this.run(command, timeout),
    });

    return { bash };
  }

  run(command, timeout) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';
      const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
      const child = spawn(shell, args, { cwd: this.cwd, env: process.env });

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve({ title: command, output: `Command timed out after ${timeout}ms\n${truncate(stdout)}${stderr ? '\nSTDERR:\n' + truncate(stderr) : ''}`, metadata: { code: 124, timeout: true } });
      }, timeout);

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ title: command, output: `Failed to start command: ${err.message}`, metadata: { code: 1, error: true } });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parts = [];
        if (stdout) parts.push(truncate(stdout.trimEnd()));
        if (stderr) parts.push((stdout ? '\nSTDERR:\n' : '') + truncate(stderr.trimEnd()));
        if (!parts.length) parts.push(`(no output, exit code ${code})`);
        if (code !== 0) parts.push(`\n[exit code ${code}]`);
        resolve({ title: command, output: parts.join(''), metadata: { code } });
      });
    });
  }
}
