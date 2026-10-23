import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from '../src/session/store.js';

test('session IDs are encoded as safe single filenames', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-session-safe-id-'));
  try {
    const store = new SessionStore({ dir });
    assert.equal(path.dirname(store.file('../../outside')), dir);
    await store.save({ id: '../../outside', messages: [] });
    assert.equal(await fs.pathExists(path.join(dir, encodeURIComponent('../../outside') + '.json')), true);
    assert.equal(await fs.pathExists(path.resolve(dir, '../../outside.json')), false);
  } finally {
    await fs.remove(dir);
  }
});
