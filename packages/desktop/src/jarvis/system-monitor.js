import os from 'node:os';

function memorySnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free), usedPercent: total ? ((total - free) / total) * 100 : 0 };
}

export function getSystemSnapshot() {
  const memory = memorySnapshot();
  return {
    platform: process.platform,
    arch: process.arch,
    uptimeSeconds: os.uptime(),
    cpuCount: os.cpus().length,
    loadAverage: os.loadavg(),
    memory,
    hostname: os.hostname(),
    capturedAt: new Date().toISOString(),
  };
}
