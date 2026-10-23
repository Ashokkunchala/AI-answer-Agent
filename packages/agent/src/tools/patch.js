// Minimal unified-diff parser + applier used by the `patch` tool.
// Supports the standard `--- a/x` / `+++ b/x` / `@@ -l,s +l,s @@` format that
// git and `diff -u` produce. Fuzz-free: hunks must match the file exactly,
// but we search the whole file if the header line numbers drift.

export function parseUnifiedDiff(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const files = [];
  let current = null;
  let hunk = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith('--- ')) {
      const next = lines[index + 1] || '';
      const plus = next.startsWith('+++ ') ? next.slice(4).trim() : '';
      const minus = line.slice(4).trim();
      current = { from: stripPrefix(minus), path: stripPrefix(plus) || stripPrefix(minus), hunks: [] };
      files.push(current);
      index += 2;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && current) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      index += 1;
      continue;
    }
    if (hunk && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line === '' || line.startsWith('\\'))) {
      if (line.startsWith('\\')) { index += 1; continue; }
      hunk.lines.push(line);
    }
    index += 1;
  }
  return files.filter((f) => f.hunks.length);
}

function stripPrefix(p) {
  return p.replace(/^[ab]\//, '').replace(/^"(.*)"$/, '$1').trim();
}

export function applyHunks(originalText, hunks) {
  const eol = /\r\n/.test(originalText) ? '\r\n' : '\n';
  let lines = originalText.replace(/\r\n/g, '\n').split('\n');
  let offset = 0;
  for (const hunk of hunks) {
    const oldBlock = [];
    const newBlock = [];
    for (const raw of hunk.lines) {
      const marker = raw[0];
      const content = raw.slice(1);
      if (marker === ' ') { oldBlock.push(content); newBlock.push(content); }
      else if (marker === '-') oldBlock.push(content);
      else if (marker === '+') newBlock.push(content);
    }
    const start = findBlock(lines, oldBlock, Math.max(0, hunk.oldStart - 1 + offset));
    if (start < 0) throw new Error(`Hunk at line ${hunk.oldStart} did not match the file content`);
    lines = [...lines.slice(0, start), ...newBlock, ...lines.slice(start + oldBlock.length)];
    offset += newBlock.length - oldBlock.length;
  }
  return lines.join('\n').replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
}

// Locate `block` in `lines`, preferring `hint` but falling back to a full scan.
function findBlock(lines, block, hint) {
  if (!block.length) return Math.min(hint, lines.length);
  const matchesAt = (i) => {
    if (i < 0 || i + block.length > lines.length) return false;
    for (let k = 0; k < block.length; k++) if (lines[i + k] !== block[k]) return false;
    return true;
  };
  if (matchesAt(hint)) return hint;
  for (let i = 0; i <= lines.length - block.length; i++) if (matchesAt(i)) return i;
  return -1;
}
