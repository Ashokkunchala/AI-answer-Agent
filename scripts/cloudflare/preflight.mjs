import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

// Spawn the locally installed wrangler with the current Node binary. Going
// through `npx` breaks on Windows (execFileSync cannot spawn npx.cmd without
// a shell), which made this preflight fail on every Windows checkout.
function resolveWranglerBin() {
  const pkgPath = require.resolve('wrangler/package.json');
  return join(dirname(pkgPath), 'bin', 'wrangler.js');
}

const requiredFiles = [
  'packages/worker/src/entrypoint.js',
  'packages/worker/src/router.js',
  'packages/worker/src/workflows/interview-analysis.js',
  'packages/worker/src/durable/interview-session.js',
  'packages/worker/migrations/0001_interview_core.sql',
];

const requiredBindings = ['API_KEYS', 'AI'];

let failed = false;
for (const file of requiredFiles) {
  try { await readFile(file); console.log(`✓ ${file}`); }
  catch { console.error(`✗ missing ${file}`); failed = true; }
}

try {
  const toml = await readFile('packages/worker/wrangler.toml', 'utf8');
  for (const binding of requiredBindings) {
    if (!toml.includes(`binding = "${binding}"`)) {
      console.error(`✗ missing binding ${binding}`);
      failed = true;
    } else console.log(`✓ binding ${binding}`);
  }
} catch {
  console.error('✗ packages/worker/wrangler.toml not readable');
  failed = true;
}

try {
  execFileSync(process.execPath, [resolveWranglerBin(), 'deploy', '--dry-run'], { cwd: 'packages/worker', stdio: 'inherit' });
  console.log('✓ Wrangler dry-run');
} catch {
  console.error('✗ Wrangler dry-run failed');
  failed = true;
}

if (failed) process.exit(1);
console.log('\nPreflight passed. Account-specific resource IDs and secrets are still required for a production deployment.');
