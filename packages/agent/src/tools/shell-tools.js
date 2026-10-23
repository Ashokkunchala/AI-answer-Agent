import { spawn, spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { defineTool } from './define-tool.js';
import { resolvePath } from './path-utils.js';

const MAX_OUTPUT = 30000;
const MAX_TIMEOUT = 15 * 60 * 1000;

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n… [truncated ${text.length - MAX_OUTPUT} chars]`;
}

function appendOutput(current, chunk) {
  const text = chunk.toString('utf8');
  const remaining = Math.max(0, MAX_OUTPUT - current.length);
  return { text: current + text.slice(0, remaining), truncated: text.length > remaining };
}

function formatOutput(text, truncated) {
  return truncated ? `${text}\n[output truncated]` : truncate(text);
}

function commandExists(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(finder, [name], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

// Execute shell commands with optional persistent working directory.
export class ShellTools {
  constructor(opts = {}) {
    this.cwd = opts.cwd || process.cwd();
    this.lastCwd = this.cwd;
    this.shellOverride = opts.shell;
    this._shell = null;
  }

  resolve(p) {
    return resolvePath(this.cwd, p);
  }

  // Resolve the shell binary + args lazily, honouring config.shell.
  get shell() {
    if (this._shell) return this._shell;
    if (this.shellOverride) {
      this._shell = this.buildShell(this.shellOverride);
      return this._shell;
    }
    if (process.platform === 'win32') {
      if (commandExists('pwsh')) this._shell = this.buildShell('pwsh');
      else if (commandExists('powershell')) this._shell = this.buildShell('powershell');
      else this._shell = this.buildShell('cmd');
    } else {
      const sh = process.env.SHELL || (commandExists('bash') ? 'bash' : '/bin/sh');
      this._shell = this.buildShell(sh);
    }
    return this._shell;
  }

  buildShell(shell) {
    const base = path.basename(shell).toLowerCase();
    let args;
    if (base.startsWith('cmd')) args = ['/d', '/s', '/c'];
    else if (base.startsWith('pwsh') || base.startsWith('powershell')) args = ['-NoProfile', '-NonInteractive', '-Command'];
    else args = ['-c'];
    return { bin: shell, args };
  }

  get tools() {
    const bash = defineTool({
      name: 'bash',
      category: 'shell',
      description:
        'Execute a shell command in the workspace. Supports a persistent working directory: a bare `cd <path>` changes the directory for subsequent commands. Use the description field to state intent.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
          description: { type: 'string', description: 'Short description of what the command does' },
          timeout: { type: 'integer', description: 'Timeout in milliseconds (default 120000)' },
          cwd: { type: 'string', description: 'Run the command in this directory for this call only' },
        },
        required: ['command'],
      },
      execute: (args) => this.run(args),
    });
    return { bash };
  }

  // Detect a bare `cd` so the working directory persists across calls.
  maybeChangeDirectory(command) {
    const trimmed = String(command).trim().replace(/;$/, '');
    const match = /^(?:cd|chdir|set-location|sl|pushd)\s+(.+)$/i.exec(trimmed);
    if (!match) return null;
    let target = match[1].trim().replace(/^["']|["']$/g, '');
    if (target === '~') target = process.env.HOME || process.env.USERPROFILE || target;
    const next = this.resolve(target);
    return next;
  }

  async run({ command, timeout = 120000, cwd: callCwd, signal: externalSignal }) {
    const cd = this.maybeChangeDirectory(command);
    if (cd) {
      if (await fs.pathExists(cd)) {
        this.lastCwd = cd;
        return { title: command, output: `Changed working directory to ${cd}`, metadata: { code: 0, cwd: cd } };
      }
      return { title: command, output: `Directory not found: ${cd}`, metadata: { code: 1, error: true, cwd: this.lastCwd } };
    }

    const runDir = callCwd ? this.resolve(callCwd) : this.lastCwd;
    const { bin, args } = this.shell;
    const finalArgs = [...args, command];
    const timeoutMs = Number.isFinite(timeout) ? Math.max(1000, Math.min(MAX_TIMEOUT, Math.trunc(timeout))) : 120000;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(bin, finalArgs, { cwd: runDir, env: process.env, windowsHide: true });
      } catch (err) {
        resolve({ title: command, output: `Failed to start command: ${err.message}`, metadata: { code: 1, error: true, cwd: runDir } });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;

      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener?.('abort', onAbort);
        resolve(result);
      };
      const onAbort = () => {
        try { child.kill(); } catch { /* ignore */ }
        done({ title: command, output: `Command aborted.\n${formatOutput(stdout, stdoutTruncated)}`, metadata: { code: 130, aborted: true, cwd: runDir } });
      };

      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        done({
          title: command,
          output: `Command timed out after ${timeoutMs}ms\n${formatOutput(stdout, stdoutTruncated)}${stderr ? '\nSTDERR:\n' + formatOutput(stderr, stderrTruncated) : ''}`,
          metadata: { code: 124, timeout: true, cwd: runDir },
        });
      }, timeoutMs);

      if (externalSignal) {
        if (externalSignal.aborted) return onAbort();
        externalSignal.addEventListener?.('abort', onAbort, { once: true });
      }

      child.stdout?.on('data', (d) => {
        const next = appendOutput(stdout, d);
        stdout = next.text;
        stdoutTruncated ||= next.truncated;
      });
      child.stderr?.on('data', (d) => {
        const next = appendOutput(stderr, d);
        stderr = next.text;
        stderrTruncated ||= next.truncated;
      });
      child.on('error', (err) => done({ title: command, output: `Failed to start command: ${err.message}`, metadata: { code: 1, error: true, cwd: runDir } }));
      child.on('close', (code) => {
        const parts = [];
        if (stdout) parts.push(formatOutput(stdout.trimEnd(), stdoutTruncated));
        if (stderr) parts.push((stdout ? '\nSTDERR:\n' : '') + formatOutput(stderr.trimEnd(), stderrTruncated));
        if (!parts.length) parts.push(`(no output, exit code ${code})`);
        if (code !== 0) parts.push(`\n[exit code ${code}]`);
        done({ title: command, output: parts.join(''), metadata: { code, cwd: runDir } });
      });
    });
  }
}
