import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { ConfigLoader, ConfigSchema, redactConfig } from '../src/config/loader.js';

test('redacts secret-like keys at every config depth', () => {
  const input = { apiKey: 'worker-secret', extra: { awsSecretAccessKey: 'aws-secret', token: 'session-secret', retries: 3 } };
  const output = redactConfig(input);
  assert.deepEqual(output, { apiKey: '[configured]', extra: { awsSecretAccessKey: '[configured]', token: '[configured]', retries: 3 } });
  assert.equal(input.apiKey, 'worker-secret');
});

test('ConfigSchema maps placeholder model names back to auto', () => {
  assert.equal(ConfigSchema.parse({}).model, 'auto');
  assert.equal(ConfigSchema.parse({ model: '[name]' }).model, 'auto');
  assert.equal(ConfigSchema.parse({ model: '<name>' }).model, 'auto');
  assert.equal(ConfigSchema.parse({ model: '${model}' }).model, 'auto');
  assert.equal(ConfigSchema.parse({ model: '   ' }).model, 'auto');
});

test('ConfigSchema keeps real model names intact', () => {
  assert.equal(ConfigSchema.parse({ model: 'gemma-4-26b' }).model, 'gemma-4-26b');
  assert.equal(ConfigSchema.parse({ model: 'auto' }).model, 'auto');
  assert.equal(ConfigSchema.parse({ model: 'gpt-5.6-sol' }).model, 'gpt-5.6-sol');
});

test('ConfigLoader sanitizes a placeholder model from a project config file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-config-'));
  try {
    await fs.ensureDir(path.join(dir, '.agent'));
    await fs.writeJson(path.join(dir, '.agent', 'config.json'), {
      workerUrl: 'https://example.invalid',
      model: '[name]',
    });
    const { config, source } = await new ConfigLoader({ cwd: dir }).load();
    assert.equal(config.model, 'auto');
    assert.equal(config.workerUrl, 'https://example.invalid');
    assert.match(String(source), /\.agent[\\/]config\.json$/);
  } finally {
    await fs.remove(dir);
  }
});

test('ConfigLoader caches loaded config and supports reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-config-reload-'));
  try {
    await fs.ensureDir(path.join(dir, '.agent'));
    await fs.writeJson(path.join(dir, '.agent', 'config.json'), {
      workerUrl: 'https://first.invalid',
      model: 'model-one',
    });
    const loader = new ConfigLoader({ cwd: dir });
    const { config, source } = await loader.load();
    assert.equal(config.workerUrl, 'https://first.invalid');
    assert.equal(config.model, 'model-one');
    assert.equal(loader.loadedConfig.workerUrl, 'https://first.invalid');
    assert.equal(loader.configSource, source);

    // Modify config file externally
    await fs.writeJson(path.join(dir, '.agent', 'config.json'), {
      workerUrl: 'https://second.invalid',
      model: 'model-two',
    });

    // Cached config should still be the old one
    assert.equal(loader.loadedConfig.workerUrl, 'https://first.invalid');

    // Reload should pick up the new config
    const reloaded = await loader.reload();
    assert.equal(reloaded.config.workerUrl, 'https://second.invalid');
    assert.equal(reloaded.config.model, 'model-two');
    assert.equal(loader.loadedConfig.workerUrl, 'https://second.invalid');
  } finally {
    await fs.remove(dir);
  }
});

test('ConfigLoader save updates cached config when saving to current source', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-config-save-'));
  try {
    await fs.ensureDir(path.join(dir, '.agent'));
    await fs.writeJson(path.join(dir, '.agent', 'config.json'), {
      workerUrl: 'https://original.invalid',
      model: 'original',
    });
    const loader = new ConfigLoader({ cwd: dir });
    await loader.load();
    assert.equal(loader.loadedConfig.workerUrl, 'https://original.invalid');

    // Save new config to the same path
    await loader.save({ workerUrl: 'https://updated.invalid', model: 'updated' });
    assert.equal(loader.loadedConfig.workerUrl, 'https://updated.invalid');
    assert.equal(loader.loadedConfig.model, 'updated');
  } finally {
    await fs.remove(dir);
  }
});
