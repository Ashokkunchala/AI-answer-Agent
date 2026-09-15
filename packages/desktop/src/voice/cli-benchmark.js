#!/usr/bin/env node
// cli-benchmark.js — offline voice pipeline benchmark.
//
//   node src/voice/cli-benchmark.js --wav <recording.wav> [options]
//
// Options:
//   --key <deepgram-api-key>   Enable REAL streaming STT measurement.
//   --worker-url <url>         Worker for REAL AI answers (with --api-key).
//   --api-key <key>            Worker bearer key.
//   --speed <multiplier>       Feed pace (default 1 = real time; 4 = faster).
//   --config <path>            Path to the app's config.json (reuses keys).
//
// Reports a JSON latency/accuracy report to stdout, plus a budget verdict.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { BenchmarkRunner } = require('./benchmark-runner');
const { StreamingSTT } = require('./streaming-stt');
const { AiClient } = require('./ai-client');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        opts[key] = value;
        i++;
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

function loadAppConfig(explicitPath) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  const base = process.env.APPDATA;
  if (base) {
    const roots = [
      path.join(base, 'devops-ai-agent-suite', 'config.json'),
      path.join(base, 'devops-ai-agent-suite-desktop', 'config.json'),
    ];
    for (const r of roots) candidates.push(r);
  }
  const home = os.homedir();
  candidates.push(path.join(home, '.wishai-voice', 'config.json'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8'));
    } catch (_) { /* try next */ }
  }
  return {};
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.wav) {
    console.error(`
Usage: node src/voice/cli-benchmark.js --wav <recording.wav> [--key DEEPGRAM_KEY] [--worker-url URL] [--api-key KEY] [--speed 1] [--config PATH]

A WAV file is required. Without --key the run measures the DSP+VAD path only
(no streaming STT transcription).
`);
    process.exit(1);
  }
  if (!fs.existsSync(opts.wav)) {
    console.error('WAV file not found:', opts.wav);
    process.exit(1);
  }

  const cfg = loadAppConfig(opts.config);
  const deepgramKey = opts.key || cfg.deepgramApiKey || process.env.DEEPGRAM_KEY || '';
  const workerUrl = opts.workerUrl || cfg.workerUrl || '';
  const apiKey = opts.apiKey || cfg.apiKey || '';
  const speed = Number(opts.speed) || 1;

  const stt = deepgramKey ? new StreamingSTT({ apiKey: deepgramKey, log: () => { } }) : null;
  const ai = workerUrl ? new AiClient({ workerUrl, defaultWorkerUrl: workerUrl, apiKey, resume: cfg.resume, jobDesc: cfg.jobDesc, targetName: cfg.targetName, participants: cfg.participants }) : null;

  const runner = new BenchmarkRunner({ stt, ai, sampleRate: 16000 });

  if (stt) {
    const c = stt.connect();
    if (!c.ok) {
      console.error('STT failed to connect (bad key?):', c.error);
      process.exit(1);
    }
  }
  await new Promise((r) => setTimeout(r, 1500)); // let handshake finish

  const report = await runner.runWav(opts.wav, { speed, askAI: !!ai });

  const verdict = (() => {
    const t = report.latency.stats.total;
    if (!stt) return 'PIPELINE_ONLY (no STT key — transcription & AI not measured)';
    const lastQ = report.latency.last;
    const ms = lastQ ? lastQ.ms : 0;
    return ms > 1500 ? 'OVER_BUDGET' : 'WITHIN_1500MS_BUDGET';
  })();

  console.log(JSON.stringify({ verdict, report }, null, 2));
}

main().catch((err) => {
  console.error('Benchmark failed:', err && err.stack || err);
  process.exit(1);
});