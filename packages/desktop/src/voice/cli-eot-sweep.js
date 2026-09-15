'use strict';
// EOT tuning experiment: stream a synthesized question through Flux with
// different eot_threshold / eot_timeout_ms, then wait for the NATURAL
// EndOfTurn (no force). Payoff: how fast does 'final' land after speech ends?
const fs = require('fs');
const path = require('path');
const https = require('https');
const { StreamingSTT } = require('./streaming-stt');

const KEY = process.env.DEEPGRAM_API_KEY;

function synth(apiKey, text) {
  const body = JSON.stringify({ text });
  const qs = 'model=aura-asteria-en&encoding=linear16&sample_rate=16000&container=wav';
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.deepgram.com/v1/speak?${qs}`, {
      method: 'POST', headers: { Authorization: 'token ' + apiKey, 'Content-Type': 'application/json', Accept: 'audio/wav' },
    }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); });
    req.on('error', reject); req.write(body); req.end();
  });
}

function decodeWav(buf) {
  const u32 = (o) => buf.readUInt32LE(o), u16 = (o) => buf.readUInt16LE(o);
  let pos = 12, sampleRate = 16000, numChannels = 1, dataOffset = 0, dataBytes = 0;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4), sz = u32(pos + 4);
    if (tag === 'fmt ') { numChannels = u16(pos + 10); sampleRate = u32(pos + 12); }
    else if (tag === 'data') { dataOffset = pos + 8; dataBytes = Math.min(sz, buf.length - dataOffset); break; }
    pos += 8 + sz; if (pos & 1) pos++;
  }
  const n = Math.floor(dataBytes / 2);
  const int16 = new Int16Array(buf.buffer, buf.byteOffset + dataOffset, n);
  const mono = numChannels > 1 ? (() => { const o = new Int16Array(n / numChannels); for (let i = 0; i < o.length; i++) o[i] = int16[i * numChannels]; return o; })() : int16;
  return { sampleRate, samples: mono };
}

function run(apiKey, pcm, { eotThreshold, eotTimeoutMs, eagerEotThreshold, tailMs, label }) {
  return new Promise((resolve) => {
    const stt = new StreamingSTT({ apiKey, sampleRate: 16000, eotThreshold, eotTimeoutMs, eagerEotThreshold, keepaliveMs: 15000, log: () => {} });
    const t0 = Date.now();
    let connectedAt = null, partialFirst = null, eagerAt = null, finalAt = null, finalText = '', trigger = '';
    let events = [];
    stt.on('connected', () => { connectedAt = Date.now(); });
    stt.on('partial', (ev) => { if (!partialFirst && ev.transcript && ev.transcript.trim()) partialFirst = Date.now(); });
    stt.on('eager-end', (ev) => { if (!eagerAt) eagerAt = Date.now(); events.push('eager:' + (ev.endOfTurnConfidence || 0).toFixed(2)); });
    stt.on('final', (ev) => { if (!finalAt) { finalAt = Date.now(); finalText = ev.transcript; trigger = ev.trigger || 'model'; } });
    stt.on('error', (e) => events.push('err:' + e.code));
    stt.connect();

    const chunkSize = Math.round(16000 * 80 / 1000) * 2;
    const chunks = [];
    for (let i = 0; i < pcm.length; i += chunkSize) chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset + i, Math.min(chunkSize, pcm.length - i)));
    // Append a realistic silence tail (the pause after the interviewer stops).
    if (tailMs) {
      const silChunks = Math.max(1, Math.round((tailMs / 80)));
      for (let i = 0; i < silChunks; i++) chunks.push(Buffer.alloc(chunkSize));
    }

    const feedMs = chunks.length * 80;
    const timer = setInterval(() => {
      if (chunks.length) { stt.sendAudio(chunks.shift()); return; }
      clearInterval(timer);
      stt.flushSend();
    }, 80);

    setTimeout(() => {
      stt.stopSession();
      resolve({
        label,
        eotThreshold, eotTimeoutMs, eagerEotThreshold, tailMs,
        feedMs: Math.round(feedMs),
        connectedMs: connectedAt ? connectedAt - t0 : null,
        firstPartialMs: partialFirst ? partialFirst - t0 : null,
        eagerMs: eagerAt ? eagerAt - t0 : null,
        finalMs: finalAt ? finalAt - t0 : null,
        finalAfterSpeech: finalAt ? (finalAt - t0) - feedMs : null,  // EOT latency after feed end
        finalText: finalText.slice(0, 60),
        trigger,
      });
    }, feedMs + 6000);
  });
}

async function main() {
  const wav = await synth(KEY, 'Explain the difference between Docker and Kubernetes in a DevOps context.');
  const { sampleRate, samples } = decodeWav(wav);
  const pcm = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  console.log('audioMs ~', Math.round(pcm.length / 32), '(plus tails)');

  const configs = [
    { eotThreshold: 0.5, eotTimeoutMs: 2000, eagerEotThreshold: 0.5, tailMs: 1500, label: '0.5/2000/0.5 tail1.5s' },
    { eotThreshold: 0.5, eotTimeoutMs: 1500, eagerEotThreshold: 0.5, tailMs: 1500, label: '0.5/1500/0.5 tail1.5s' },
    { eotThreshold: 0.4, eotTimeoutMs: 1000, eagerEotThreshold: 0.4, tailMs: 1500, label: '0.4/1000/0.4 tail1.5s' },
    { eotThreshold: 0.5, eotTimeoutMs: 1000, eagerEotThreshold: 0.4, tailMs: 1200, label: '0.5/1000/0.4 tail1.2s' },
    { eotThreshold: 0.6, eotTimeoutMs: 2000, eagerEotThreshold: 0.5, tailMs: 2000, label: '0.6/2000/0.5 tail2s' },
  ];

  const results = [];
  for (const c of configs) {
    const r = await run(KEY, pcm, c);
    results.push(r);
    console.log(JSON.stringify(r));
  }
  fs.writeFileSync(path.join(require('os').tmpdir(), 'eot-sweep-' + Date.now() + '.json'), JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });