import test from 'node:test';
import assert from 'node:assert/strict';
import { ShellTools } from '../src/tools/shell-tools.js';

test('shell output is bounded while marking truncated output', async () => {
  const shell = new ShellTools({ cwd: process.cwd() });
  const executable = JSON.stringify(process.execPath);
  const command = `${process.platform === 'win32' ? '& ' : ''}${executable} -e "process.stdout.write('x'.repeat(40000))"`;
  const result = await shell.run({ command, timeout: 5000 });
  assert.equal(result.metadata.code, 0, result.output.slice(-500));
  assert.ok(result.output.length < 30100);
  assert.match(result.output, /output truncated/);
});
