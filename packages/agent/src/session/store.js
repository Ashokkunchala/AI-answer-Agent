import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { storageFilename } from '../utils/ids.js';

export function defaultSessionsDir() {
  const home = os.homedir();
  const legacyDir = path.join(home, '.workercli', 'sessions');
  return fs.pathExistsSync(legacyDir) ? legacyDir : path.join(home, '.agent-terminal', 'sessions');
}

// JSON-per-session store under ~/.agent-terminal/sessions, retaining an
// existing workercli session directory for upgrade compatibility.
export class SessionStore {
  constructor(opts = {}) {
    this.dir = opts.dir || defaultSessionsDir();
  }

  file(id) {
    return path.join(this.dir, storageFilename(id));
  }

  async save(session) {
    if (!session || !session.id) return null;
    await fs.ensureDir(this.dir);
    const data = { ...session, updatedAt: new Date().toISOString() };
    const f = this.file(session.id);
    await fs.writeJson(f, data, { spaces: 2 });
    return f;
  }

  async load(id) {
    const f = this.file(id);
    if (!(await fs.pathExists(f))) return null;
    try {
      return await fs.readJson(f);
    } catch {
      return null;
    }
  }

  async list() {
    if (!(await fs.pathExists(this.dir))) return [];
    const files = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const f of files) {
      try {
        const data = await fs.readJson(path.join(this.dir, f));
        out.push({
          id: data.id,
          title: data.title || '(untitled)',
          updatedAt: data.updatedAt || '',
          cwd: data.cwd || '',
          turns: (data.messages || []).filter((m) => m.role === 'user').length,
        });
      } catch {
        /* skip corrupt files */
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  async remove(id) {
    const f = this.file(id);
    if (await fs.pathExists(f)) {
      await fs.remove(f);
      return true;
    }
    return false;
  }

  // Fork a session into a new id, copying its messages and summary.
  async fork(id, newId) {
    const source = await this.load(id);
    if (!source) return null;
    const copy = {
      ...source,
      id: newId,
      title: `${source.title || 'session'} (branch)`,
      createdAt: new Date().toISOString(),
      branchedFrom: id,
    };
    await this.save(copy);
    return copy;
  }
}
