import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCore } from '../src/core/agent-core.js';

test('a simple greeting is answered without a Worker model request', async () => {
  let modelCalls = 0;
  const events = [];
  const agent = new AgentCore({
    client: { chat: async () => { modelCalls += 1; return { choices: [{ message: { content: 'model answer' } }] }; } },
    config: { streaming: false, tools: false },
  });

  const reply = await agent.chat({ message: 'hi', sessionId: 'greeting-check', onEvent: (event) => events.push(event.type) });

  assert.equal(reply, "Hi! I'm here. What would you like to work on?");
  assert.equal(modelCalls, 0);
  assert.ok(events.includes('content'));
  assert.ok(events.includes('done'));
});

test('the same session returns to the Worker model for a substantive request', async () => {
  let modelCalls = 0;
  const agent = new AgentCore({
    client: { chat: async () => { modelCalls += 1; return { choices: [{ message: { content: 'model answer' } }] }; } },
    config: { streaming: false, tools: false },
  });
  agent.skills.catalog = async () => '';

  await agent.chat({ message: 'hi', sessionId: 'normal-check' });
  const reply = await agent.chat({ message: 'Explain DevOps briefly.', sessionId: 'normal-check' });

  assert.equal(reply, 'model answer');
  assert.equal(modelCalls, 1);
});
