import fs from 'fs-extra';
import path from 'node:path';

// Ordered by preference: cheap/fast correctness checks first, tests last.
const CHECK_SCRIPTS = ['typecheck', 'lint', 'test'];

// Find the nearest project check command by walking up from `cwd` to the first
// package.json. Returns null when the project defines no lint/typecheck/test
// script (so we never invent commands or run heavy suites unexpectedly).
export async function findCheckCommand(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      try {
        const pkg = await fs.readJson(pkgPath);
        const scripts = pkg.scripts || {};
        for (const name of CHECK_SCRIPTS) {
          if (scripts[name]) return { cwd: dir, label: name, command: `npm run ${name}` };
        }
      } catch {
        /* ignore malformed package.json */
      }
      return null; // stop at the project root; don't walk past it
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
