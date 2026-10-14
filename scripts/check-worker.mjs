#!/usr/bin/env node
'use strict';

// Diagnose the local Cloudflare Worker connection used by the desktop/CLI.
const base = (process.env.WORKER_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const timeoutMs = Number(process.env.WORKER_CHECK_TIMEOUT_MS || 3000);

async function main() {
  let response;
  try {
    response = await fetch(base + '/health', { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    console.error('\nWorker is not reachable:', base);
    console.error('Cause:', error.cause?.code || error.message);
    console.error('\nStart it from the repository root in a separate terminal:');
    console.error('  npm install');
    console.error('  npm run dev:worker');
    console.error('\nWait for Wrangler to report that it is listening (normally http://127.0.0.1:8787),');
    console.error('then rerun: npm run check:worker');
    console.error('\nIf port 8787 is already in use, set WORKER_URL to the actual local URL.');
    process.exitCode = 1;
    return;
  }

  const body = await response.text();
  if (!response.ok) {
    console.error(`Worker responded with HTTP ${response.status}: ${body.slice(0, 500)}`);
    process.exitCode = 1;
    return;
  }

  let health;
  try { health = JSON.parse(body); } catch { health = null; }
  console.log('Worker reachable:', base);
  console.log('HTTP status:', response.status);
  if (health) {
    console.log('Service:', health.name || 'unknown');
    console.log('Version:', health.version || 'unknown');
    console.log('Status:', health.status || 'unknown');
  } else {
    console.log('Health response was not JSON; connectivity is confirmed, response format should be checked.');
  }
}

main().catch((error) => {
  console.error('Worker preflight failed:', error.stack || error);
  process.exitCode = 1;
});
