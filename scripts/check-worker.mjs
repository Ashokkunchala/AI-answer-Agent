#!/usr/bin/env node
'use strict';

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
    console.error('\nWait for Wrangler to report its listening URL, then run: npm run check:worker');
    console.error('If Wrangler selected another port, set WORKER_URL to that actual URL.');
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
    console.log('Health endpoint responded, but its body was not JSON.');
  }
}
main().catch((error) => {
  console.error('Worker preflight failed:', error.stack || error);
  process.exitCode = 1;
});
