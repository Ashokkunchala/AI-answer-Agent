#!/usr/bin/env node
// cli-live-check.js — live performance probe (STT + AI) against real services.
//
//   node src/voice/cli-live-check.js [--key <deepgram-api-key>] [--worker-url URL] [--api-key KEY] [--text <question>] [--speed N] [--repeat N]
//
// Synthesizes a real interview question via Deepgram Speak → feeds the PCM
// through the Flux streaming STT → measures first-partial / final / question-
// detected / AI first-token / AI completion latencies. Passes the full budget
// verdict (whis-ai <2s target).
//
// Keys are resolved from: --key flag, DEEPGRAM_API_KEY env, app config.json.
// The AI path uses the worker in direct-use (anonymous) mode when --api-key is
// omitted, matching the desktop app default.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const { StreamingSTT } = require('./streaming-stt');
const { detectQuestion } = require('./question-detector');
const { AiClient } = require('./ai-client');

/* -------------------------------------------------------------------- */
/*  Argument parsing                                                     */
/* -------------------------------------------------------------------- */
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val !== undefined && !val.startsWith('--')) { opts[key] = val; i++; }
    else opts[key] = true;
  }
  return opts;
}

function loadAppConfig(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const base = process.env.APPDATA;
  if (base) {
    candidates.push(path.join(base, 'devops-ai-agent-suite', 'config.json'));
    candidates.push(path.join(base, 'devops-ai-agent-suite-desktop', 'config.json'));
  }
  candidates.push(path.join(os.homedir(), '.wishai-voice', 'config.json'));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8')); } catch (_) { /* skip */ }
  }
  return {};
}

/* -------------------------------------------------------------------- */
/*  Deepgram Speak (TTS) — generate a test-question WAV                  */
/* -------------------------------------------------------------------- */
function synthesizeSpeech(apiKey, { text, model, sampleRate }) {
  const body = JSON.stringify({ text });
  const qs = `model=${encodeURIComponent(model || 'aura-asteria-en')}&encoding=linear16&sample_rate=${sampleRate || 16000}&container=wav`;
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.deepgram.com/v1/speak?${qs}`, {
      method: 'POST',
      headers: {
        Authorization: `token ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const errBody = Buffer.concat(chunks).toString('utf8');
          return reject(new Error(`Deepgram Speak HTTP ${res.statusCode}: ${errBody}`));
        }
        resolve(Buffer.concat(chunks));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* -------------------------------------------------------------------- */
/*  WAV decoder (RIFF → PCM int16 mono)                                  */
/* -------------------------------------------------------------------- */
// WAV decoder (RIFF → PCM int16 mono)
/* -------------------------------------------------------------------- */
function decodeWav(buf) {
  const u32 = (o) => buf.readUInt32LE(o);
  const u16 = (o) => buf.readUInt16LE(o);
  const sig = buf.toString('ascii', 0, 4);
  if (sig !== 'RIFF') throw new Error('Not a RIFF file');
  if (buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not WAVE');

  let pos = 12;
  let sampleRate = 16000, bitsPerSample = 16, numChannels = 1;
  let dataOffset = 0, dataBytes = 0;

  while (pos + 8 <= buf.length) {
    const tag = buf.toString('ascii', pos, pos + 4);
    const chunkSize = u32(pos + 4);

    if (tag === 'fmt ') {
      numChannels = u16(pos + 10);
      sampleRate = u32(pos + 12);
      bitsPerSample = u16(pos + 22);
    } else if (tag === 'data') {
      dataOffset = pos + 8;
      dataBytes = Math.min(chunkSize, buf.length - dataOffset);
      break;
    }
    pos += 8 + chunkSize;
    if (pos & 1) pos++;  // word-align
  }

  if (dataOffset === 0 || dataBytes <= 0) throw new Error('No data chunk found');

  const samplesCount = Math.floor(dataBytes / (bitsPerSample / 8));
  const samples = buf.slice(dataOffset, dataOffset + dataBytes);
  // Return as Int16Array view (safe — Node Buffer is backed by ArrayBuffer)
  const int16 = new Int16Array(samples.buffer, samples.byteOffset, Math.min(samplesCount, Math.floor(samples.byteLength / 2)));

  // If stereo, take only the first channel
  const mono = numChannels > 1
    ? (() => { const out = new Int16Array(int16.length / numChannels); for (let i = 0; i < out.length; i++) out[i] = int16[i * numChannels]; return out; })()
    : int16;

  return { sampleRate, bitsPerSample, samples: mono, dataStart: dataOffset };
}

function resampleTo16k(samples, srcRate) {
  if (srcRate === 16000) return samples;
  const ratio = 16000 / srcRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = idx < samples.length ? samples[idx] : 0;
    const b = idx + 1 < samples.length ? samples[idx + 1] : a;
    out[i] = Math.round(a * (1 - frac) + b * frac);
  }
  return out;
}

function pcmToBuffer(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/* -------------------------------------------------------------------- */
/*  Streaming STT live probe                                             */
/* -------------------------------------------------------------------- */
function probeSTT(apiKey, pcmChunks, { eotThreshold, eagerEotThreshold, eotTimeoutMs, graceMs, audioMs, log }) {
  return new Promise((resolve) => {
    const stt = new StreamingSTT({
      apiKey,
      sampleRate: 16000,
      eotThreshold: eotThreshold ?? 0.5,
      eagerEotThreshold: eagerEotThreshold ?? 0.5,
      eotTimeoutMs: eotTimeoutMs ?? 1500,
      keepaliveMs: 15000,
      log: log || (() => {}),
    });

    const events = [];
    const push = (name, ev) => events.push({ name, at: Date.now(), ...ev });
    let firstPartialAt = null, firstPartialText = '';
    let lastPartialText = '';
    let finalAt = null, finalText = '', finalTrigger = '';
    let eagerAt = null, eagerText = '', eagerConf = null;
    let partialQAt = null, partialQText = '';
    const eagerThresh = eagerEotThreshold ?? 0.5;
    const partialQThresh = 0.55;
    const partialQMinLen = 16;
    let graceTimer = null, resolved = false;

    stt.on('connected', () => push('connected'));
    stt.on('disconnected', () => push('disconnected'));
    stt.on('turn-start', (ev) => push('turn-start', ev));
    stt.on('partial', (ev) => {
      push('partial', ev);
      if (ev.transcript && ev.transcript.trim()) lastPartialText = ev.transcript;
      if (!firstPartialAt && ev.transcript && ev.transcript.trim()) {
        firstPartialAt = Date.now();
        firstPartialText = ev.transcript;
      }
      // Whis-AI answer path: the app starts generation the moment a partial is
      // already a confident question (before end-of-turn). Track the first such
      // partial so we can measure the early-answer latency improvement.
      if (!partialQAt && ev.transcript && ev.transcript.trim().length >= partialQMinLen) {
        const q = detectQuestion(ev.transcript);
        if (q.isQuestion && q.confidence >= partialQThresh) {
          partialQAt = Date.now();
          partialQText = ev.transcript;
        }
      }
    });
    stt.on('eager-end', (ev) => {
      push('eager-end', ev);
      // Same confidence gate the app's TurnManager applies before pre-starting.
      const conf = ev.endOfTurnConfidence != null ? ev.endOfTurnConfidence : 1;
      if (eagerAt == null && conf >= eagerThresh && ev.transcript && ev.transcript.trim()) {
        eagerAt = Date.now();
        eagerText = ev.transcript;
        eagerConf = conf;
      }
    });
    stt.on('final', (ev) => {
      push('final', ev);
      if (!finalAt) { finalAt = Date.now(); finalText = ev.transcript; finalTrigger = ev.trigger || 'model'; }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (feedDone) finish(results());
    });
    stt.on('error', (err) => push('error', { code: err.code, message: err.message }));

    const connectTime = Date.now();
    stt.connect();

    // Feed chunks at ~80ms pacing (Flux-recommended chunk size). A silent tail
    // at the end mimics the pause after an interviewer stops speaking.
    // Flux's NATURAL EndOfTurn is preferred; if it hasn't decided within a
    // grace window after speech, we fall back to the last partial — the same
    // behavior the app gets from its local VAD end-of-speech path.
    const chunkMs = 80;
    const tailChunks = Math.round(1500 / chunkMs);
    const totalChunks = pcmChunks.length + tailChunks;
    const totalMs = totalChunks * chunkMs;
    const graceMsValue = graceMs ?? 1000;
    let fed = 0;
    let feedDone = false;

    function finish(res) {
      if (resolved) return;
      resolved = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      stt.stopSession();
      resolve(res);
    }

    function armGrace() {
      graceTimer = setTimeout(() => {
        const now = Date.now();
        if (!finalAt && lastPartialText) {
          // Local-VAD-equivalent: treat speech end + grace as the turn final.
          finalAt = now;
          finalText = lastPartialText;
          finalTrigger = 'vad-grace';
          push('final', { transcript: finalText, trigger: 'vad-grace' });
        }
        finish(results());
      }, graceMsValue);
    }

    const feedInterval = setInterval(() => {
      if (fed < pcmChunks.length) {
        stt.sendAudio(pcmChunks[fed++]);
        return;
      }
      stt.sendAudio(Buffer.alloc(pcmChunks[0] ? pcmChunks[0].length : 2560)); // silence (same chunk size so Flux gets a real 1.5s tail)
      fed++;
      if (fed >= totalChunks) {
        clearInterval(feedInterval);
        feedDone = true;
        stt.flushSend();
        armGrace();
      }
    }, chunkMs);

    // Absolute safety timeout in case nothing above fires.
    setTimeout(() => {
      if (!feedDone) { clearInterval(feedInterval); stt.flushSend(); }
      finish(results());
    }, totalMs + 6000);

    function results() {
      const connectedAt = events.find(e => e.name === 'connected');
      const connectMs = connectedAt ? connectedAt.at - connectTime : null;
      const audioEndAt = connectTime + (audioMs || 4000);
      const finalAfterSpeech = finalAt ? finalAt - audioEndAt : null;
      const eagerAfterSpeech = eagerAt ? eagerAt - audioEndAt : null;
      const partialQAfterSpeech = partialQAt ? partialQAt - audioEndAt : null;
      return {
        connectMs,
        firstPartialMs: firstPartialAt ? firstPartialAt - connectTime : null,
        firstPartialText,
        finalMs: finalAt ? finalAt - connectTime : null,
        finalAt,
        finalAfterSpeech,
        finalText,
        finalTrigger,
        eagerMs: eagerAt ? eagerAt - connectTime : null,
        eagerAt,
        eagerAfterSpeech,
        eagerText,
        eagerConf,
        partialQMs: partialQAt ? partialQAt - connectTime : null,
        partialQAt,
        partialQAfterSpeech,
        partialQText,
        totalSttMs: totalMs,
        eventCount: events.length,
        events,
      };
    }
  });
}

/* -------------------------------------------------------------------- */
/*  AI answer probe (worker /api/answer or /v1/chat/completions)         */
/* -------------------------------------------------------------------- */
function probeAI(ai, question, { history, conversationContext }) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let firstTokenAt = null, firstTokenText = '';
    let completionText = '';
    let error = null;

    ai.removeAllListeners();
    ai.once('first-token', () => { firstTokenAt = Date.now(); });
    ai.on('token', ({ text }) => {
      if (!firstTokenText && text) firstTokenText = text;
      completionText += text;
    });

    ai.streamAnswer({
      transcript: question,
      taskType: 'interview',
      history: history || [],
      conversationContext: conversationContext || '',
      turnId: 'live-check',
      sessionId: 'live-check-' + Date.now(),
    }).then(() => {
      resolve({
        firstTokenMs: firstTokenAt ? firstTokenAt - startTime : null,
        firstTokenAbs: firstTokenAt || null,
        completionMs: Date.now() - startTime,
        completionText,
        error: null,
      });
    }).catch((err) => {
      resolve({
        firstTokenMs: firstTokenAt ? firstTokenAt - startTime : null,
        firstTokenAbs: firstTokenAt || null,
        completionMs: Date.now() - startTime,
        completionText,
        error: err && err.message || String(err),
      });
    });
  });
}

/* -------------------------------------------------------------------- */
/*  Main                                                                 */
/* -------------------------------------------------------------------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = loadAppConfig(opts.config);
  const deepgramKey = opts.key || cfg.deepgramApiKey || process.env.DEEPGRAM_API_KEY || '';
  const workerUrl = opts.workerUrl || cfg.workerUrl || process.env.WORKER_URL || 'https://devops-ai-agent.ashokkunchla.workers.dev';
  const apiKey = opts.apiKey || cfg.apiKey || process.env.API_KEY || '';
  const questionText = opts.text || 'Explain the difference between Docker and Kubernetes in a DevOps context.';
  const speed = Number(opts.speed) || 1;

  if (!deepgramKey) {
    console.error('No Deepgram API key. Use --key or DEEPGRAM_API_KEY env.');
    process.exit(1);
  }

  console.log('─── Live Performance Check ───');
  console.log('Question:', JSON.stringify(questionText));
  console.log('Worker URL:', workerUrl);
  console.log('');

  // Step 1: Synthesize question via Deepgram Speak
  console.log('1. Synthesizing test question via Deepgram Speak...');
  const synthStart = Date.now();
  const wavBuf = await synthesizeSpeech(deepgramKey, { text: questionText, sampleRate: 16000 });
  const synthMs = Date.now() - synthStart;
  console.log(`   WAV: ${wavBuf.length} bytes, synthesized in ${synthMs}ms`);

  const { sampleRate, samples } = decodeWav(wavBuf);
  const pcm16k = resampleTo16k(samples, sampleRate);
  const pcmBuf = pcmToBuffer(pcm16k);

  // Split into 80ms chunks (320 samples @ 16kHz = 640 bytes)
  const chunkSize = Math.round(16000 * 80 / 1000) * 2;
  const pcmChunks = [];
  for (let i = 0; i < pcmBuf.length; i += chunkSize) {
    pcmChunks.push(pcmBuf.slice(i, i + chunkSize));
  }
  const audioMs = Math.round(pcm16k.length / 16000 * 1000);
  console.log(`   Audio duration: ~${audioMs}ms, chunks: ${pcmChunks.length}`);

  // Steps 2+3: run the live cycle N times (default 1).
  // STT reconnects per cycle; the AiClient is reused so model learning and the
  // steady-state fast path carry across cycles, just like a real session.
  const repeat = Math.max(1, Number(opts.repeat) || 1);
  let aiClient = null;
  if (workerUrl) {
    aiClient = new AiClient({
      workerUrl,
      defaultWorkerUrl: workerUrl,
      apiKey,
      resume: cfg.resume,
      jobDesc: cfg.jobDesc,
      targetName: cfg.targetName,
      participants: cfg.participants,
      maxTokens: 128,
      model: 'auto',
      answerEndpoint: true,
      log: () => {},
    });
  }

  console.log('');
  console.log(`2. Live cycle${repeat > 1 ? 's' : ''} (${repeat}) — audio reused, STT reconnects each cycle...`);
  const runs = [];
  const audioEndMsRef = audioMs;
  for (let i = 0; i < repeat; i++) {
    if (repeat > 1) console.log(`\n── Cycle ${i + 1}/${repeat} ──`);
    const sttResult = await probeSTT(deepgramKey, pcmChunks, { eotThreshold: 0.5, audioMs: audioEndMsRef, log: (a) => {} });
    const transcript = sttResult.finalText || sttResult.firstPartialText || '';
    const qDetection = detectQuestion(transcript);
    const eagerDetection = detectQuestion(sttResult.eagerText || '');
    const aiResult = aiClient ? await probeAI(aiClient, transcript || questionText, { history: [], conversationContext: '' }) : null;
    const eagerQ = !!(sttResult.eagerText && eagerDetection.isQuestion);
    const partialQ = !!sttResult.partialQText;
    // Model the app's answer path: generation is kicked off the moment the
    // question is recognized — on the eager draft, on a confident PARTIAL
    // (whis-ai behavior — this is the fast path), or on the final. Latency
    // after speech end ≈ when the question was recognized + one AI round-trip
    // to the first token (aiFirstTokenMs).
    let aiStartAfterSpeechMs = null;
    let aiStartVia = null;
    if (aiResult && aiResult.firstTokenMs != null) {
      // Whis-AI path: answer generation starts the moment the question is
      // recognized on a partial — mid-speech, possibly before the interviewer
      // finishes. So the first-token latency is: (partialQ - speechEnd) + AI
      // round-trip; negative means the answer already began talking before the
      // interviewer stopped, which is why this beats the 2s budget.
      if (partialQ && sttResult.partialQAfterSpeech != null) {
        aiStartAfterSpeechMs = sttResult.partialQAfterSpeech + aiResult.firstTokenMs;
        aiStartVia = 'partial';
      } else if (eagerQ && sttResult.eagerAfterSpeechMs != null && sttResult.eagerConf >= 0.35) {
        aiStartAfterSpeechMs = Math.max(0, sttResult.eagerAfterSpeechMs) + aiResult.firstTokenMs;
        aiStartVia = 'eager';
      } else if (qDetection.isQuestion && sttResult.finalAfterSpeech != null) {
        aiStartAfterSpeechMs = Math.max(0, sttResult.finalAfterSpeech) + aiResult.firstTokenMs;
        aiStartVia = 'final';
      }
    }
    runs.push({
      run: i + 1,
      sttConnectMs: sttResult.connectMs,
      sttFirstPartialMs: sttResult.firstPartialMs,
      sttFinalMs: sttResult.finalMs,
      finalAfterSpeechMs: sttResult.finalAfterSpeech,
      eagerAfterSpeechMs: sttResult.eagerAfterSpeech,
      partialQAfterSpeechMs: sttResult.partialQAfterSpeech,
      partialQText: sttResult.partialQText || '',
      eagerText: sttResult.eagerText || '',
      eagerConf: sttResult.eagerConf,
      finalTrigger: sttResult.finalTrigger,
      finalText: sttResult.finalText,
      partialQAnswered: partialQ,
      eagerQAnswered: eagerQ,
      qDetected: qDetection.isQuestion,
      aiFirstTokenMs: aiResult ? aiResult.firstTokenMs : null,
      aiFirstTokenAbs: aiResult && aiResult.firstTokenAbs ? aiResult.firstTokenAbs : null,
      aiStartAfterSpeechMs,
      aiStartVia,
      aiCompletionMs: aiResult ? aiResult.completionMs : null,
      aiError: aiResult ? aiResult.error : null,
    });
    const row = runs[runs.length - 1];
    const ft = row.aiFirstTokenMs === null ? 'N/A' : row.aiFirstTokenMs + 'ms';
    const eag = row.eagerAfterSpeechMs == null ? '—' : (row.eagerAfterSpeechMs >= 0 ? '+' : '') + row.eagerAfterSpeechMs + 'ms';
    const pq = row.partialQAfterSpeechMs == null ? '—' : (row.partialQAfterSpeechMs >= 0 ? '+' : '') + row.partialQAfterSpeechMs + 'ms';
    console.log(`   STT connected ${row.sttConnectMs}ms · first partial ${row.sttFirstPartialMs}ms · final ${row.sttFinalMs}ms (${row.finalTrigger})`);
    console.log(`   Question in partial ${pq} vs speech end${row.partialQAnswered ? ' · answered from partial' : ''} · eager ${eag}${row.eagerQAnswered ? ' · Q in eager' : ''}`);
    console.log(`   Question detected ${row.qDetected ? 'YES' : 'NO'} · AI first token ${ft} · completion ${row.aiCompletionMs}ms${row.aiError ? ' · ERR: ' + row.aiError : ''}`);
  }

  // Step 4: Verdict (whis-ai <2s target for starting the answer after speech ends).
  const pct = (arr, p) => {
    const a = arr.filter((v) => v != null);
    if (!a.length) return null;
    const s = [...a].sort((x, y) => x - y);
    const k = Math.min(s.length - 1, Math.ceil((s.length * p) / 100) - 1);
    return s[Math.max(0, k)];
  };
  const fmt = (v) => (v == null ? 'N/A' : v + 'ms');
  const ftArr = runs.map((r) => r.aiFirstTokenMs).filter((v) => v != null);
  const afterArr = runs.map((r) => r.finalAfterSpeechMs).filter((v) => v != null);
  const eagerAfterArr = runs.map((r) => r.eagerAfterSpeechMs).filter((v) => v != null);
  const partialQAfterArr = runs.map((r) => r.partialQAfterSpeechMs).filter((v) => v != null);
  const partialAnswered = runs.filter((r) => r.partialQAnswered && r.aiFirstTokenAbs != null).length;
  const eagerAnswered = runs.filter((r) => r.eagerQAnswered && r.aiFirstTokenAbs != null).length;
  // Headline: interviewer's speech ends → answer's first token. The app answers
  // the moment the question is recognized — on a confident partial (whis-ai),
  // the eager draft, then the final as the fallback — all on the absolute clock.
  const answerLat = runs
    .map((r) => r.aiStartAfterSpeechMs)
    .filter((v) => v != null);

  console.log('');
  console.log('─── Budget Verdict ───');
  console.log(`Cycles:          ${repeat}`);
  console.log(`Q detected:      ${runs.length && runs.every((r) => r.qDetected) ? 'YES (all)' : 'mixed'}`);
  console.log(`Partial Q:       ${partialAnswered}/${runs.length} cycles answered from partial`);
  console.log(`Eager Q:         ${eagerAnswered}/${runs.length} cycles answered from eager draft`);
  if (ftArr.length) console.log(`AI first token:  p50=${fmt(pct(ftArr, 50))} · p95=${fmt(pct(ftArr, 95))} · min=${fmt(Math.min(...ftArr))}`);
  if (afterArr.length) console.log(`STT final vs speech end: p50=${fmt(pct(afterArr, 50))} · p95=${fmt(pct(afterArr, 95))}`);
  if (partialQAfterArr.length) console.log(`Question-in-partial vs speech end: p50=${fmt(pct(partialQAfterArr, 50))} · p95=${fmt(pct(partialQAfterArr, 95))}`);
  if (eagerAfterArr.length) console.log(`Eager draft vs speech end: p50=${fmt(pct(eagerAfterArr, 50))} · p95=${fmt(pct(eagerAfterArr, 95))}`);
  if (answerLat.length) {
    const a50 = pct(answerLat, 50);
    const a95 = pct(answerLat, 95);
    console.log(`Answer first token after speech end: p50=${fmt(a50)} · p95=${fmt(a95)} → ${a50 != null && a50 <= 2000 ? 'WITHIN 2s TARGET' : 'OVER 2s TARGET'}`);
  }

  const p50 = pct(ftArr, 50), p95 = pct(ftArr, 95);
  const report = { synthMs, repeat, runs, summary: { aiFirstToken: { p50, p95 }, answerAfterSpeech: { p50: pct(answerLat, 50), p95: pct(answerLat, 95) }, partialAnswered, eagerAnswered } };
  fs.writeFileSync(path.join(os.tmpdir(), 'voice-live-check-' + Date.now() + '.json'), JSON.stringify(report, null, 2));
  console.log('');
  console.log('Full report saved to tmpdir.');
}

main().catch((err) => {
  console.error('Live check failed:', err.stack || err);
  process.exit(1);
});
