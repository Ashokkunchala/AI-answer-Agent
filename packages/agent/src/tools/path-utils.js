import path from 'node:path';

// Resolve a user/model supplied path against the workspace root.
export function resolvePath(cwd, p) {
  if (p == null || p === '') return cwd;
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

// True when `target` is inside `root` (or equals it).
export function isWithin(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Normalize to forward slashes for display.
export function displayPath(p) {
  return String(p).split(path.sep).join('/');
}
