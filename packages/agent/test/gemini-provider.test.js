import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ProviderClient } from '../src/client/provider-client.js';

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}/v1beta/openai`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Gemini provider sends OpenAI-compatible tool requests without Worker-only fields', async () => {
  let request;
  await withServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Ready.' } }] }));
  }, async (geminiUrl) => {
    const client = new ProviderClient({ provider: 'gemini', geminiUrl, apiKey: 'test-key', model: 'auto' });
    const result = await client.chat({
      messages: [{ role: 'user', content: 'inspect this project' }],
      task_type: 'review',
      raw: true,
      tool_stream: true,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
    });
    assert.equal(result.choices[0].message.content, 'Ready.');
  });
  assert.equal(request.url, '/v1beta/openai/chat/completions');
  assert.equal(request.authorization, 'Bearer test-key');
  assert.equal(request.body.model, 'gemini-3.8-flash');
  assert.equal(request.body.tools[0].function.name, 'read');
  for (const key of ['raw', 'task_type', 'tool_stream', 'sessionId', 'turnId']) assert.equal(key in request.body, false);
});

test('Gemini provider lists models and uses that endpoint for its health check', async () => {
  const paths = [];
  await withServer((req, res) => {
    paths.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gemini-3.8-flash', name: 'Gemini Flash' }] }));
  }, async (geminiUrl) => {
    const client = new ProviderClient({ provider: 'gemini', geminiUrl, apiKey: 'test-key' });
    assert.equal((await client.models())[0].id, 'gemini-3.8-flash');
    assert.equal((await client.health()).ok, true);
  });
  assert.deepEqual(paths, ['/v1beta/openai/models', '/v1beta/openai/models']);
});
