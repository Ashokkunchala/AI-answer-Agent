// Minimal, dependency-free Markdown renderer for the ink TUI.
// Returns an array of ink <Text> nodes. Handles headings, bullet/numbered
// lists, fenced code blocks, blockquotes, **bold** and `inline code`.
// Plain text is passed through verbatim so streaming output is unchanged.
import React from 'react';
import { Text } from 'ink';

const h = React.createElement;

function inline(text, keyBase) {
  const parts = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(h(Text, { key: `${keyBase}b${i}`, bold: true }, tok.slice(2, -2)));
    } else {
      parts.push(h(Text, { key: `${keyBase}c${i}`, color: 'yellow' }, tok.slice(1, -1)));
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

export function renderMarkdown(text) {
  const src = String(text ?? '');
  if (!src) return [];
  const lines = src.split('\n');
  const nodes = [];
  let inCode = false;
  let code = [];
  let k = 0;

  const flushCode = () => {
    if (code.length) {
      nodes.push(h(Text, { key: `code${k++}`, color: 'gray' }, code.map((l) => `  ${l}`).join('\n')));
      code = [];
    }
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      nodes.push(h(Text, { key: `h${k++}`, bold: true, color: 'cyan' }, line.replace(/^#{1,6}\s+/, '')));
      continue;
    }
    if (/^>\s?/.test(line)) {
      nodes.push(h(Text, { key: `q${k++}`, color: 'gray' }, `│ ${line.replace(/^>\s?/, '')}`));
      continue;
    }
    const bullet = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      nodes.push(h(Text, { key: `l${k++}` }, `${bullet[1]}• `, ...inline(bullet[3], `l${k}`)));
      continue;
    }
    nodes.push(h(Text, { key: `t${k++}` }, ...inline(line, `t${k}`)));
  }
  if (inCode) flushCode();
  return nodes;
}
