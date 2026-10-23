import test from 'node:test';
import assert from 'node:assert/strict';
import { WebTools } from '../src/tools/web-tools.js';

function publicLookup() {
  return async () => [{ address: '93.184.216.34', family: 4 }];
}

test('webfetch rejects local addresses before making a request', async () => {
  let requests = 0;
  const web = new WebTools({ fetchImpl: async () => { requests++; }, lookup: publicLookup() });
  await assert.rejects(() => web.tools.webfetch.run({ url: 'http://127.0.0.1/private' }), /Private and reserved/);
  await assert.rejects(() => web.tools.webfetch.run({ url: 'file:///etc/passwd' }), /Only HTTP/);
  await assert.rejects(() => web.tools.webfetch.run({ url: 'http://localhost/admin' }), /Local and internal/);
  assert.equal(requests, 0);
});

test('webfetch rejects public hostnames resolving to private networks', async () => {
  let requests = 0;
  const web = new WebTools({
    fetchImpl: async () => { requests++; },
    lookup: async () => [{ address: '10.0.0.7', family: 4 }],
  });
  await assert.rejects(() => web.tools.webfetch.run({ url: 'https://internal.example/path' }), /private or reserved/);
  assert.equal(requests, 0);
});

test('webfetch validates redirect targets before following them', async () => {
  let requests = 0;
  const web = new WebTools({
    lookup: publicLookup(),
    fetchImpl: async () => {
      requests++;
      return { status: 302, ok: false, headers: { get: () => 'http://169.254.169.254/latest/meta-data/' } };
    },
  });
  await assert.rejects(() => web.tools.webfetch.run({ url: 'https://public.example/redirect' }), /Private and reserved/);
  assert.equal(requests, 1);
});

test('webfetch caps downloaded response size and converts HTML to text', async () => {
  const web = new WebTools({
    lookup: publicLookup(),
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '<html><body><h1>Useful page</h1><script>ignored()</script></body></html>',
    }),
  });
  const result = await web.tools.webfetch.run({ url: 'https://public.example/page' });
  assert.match(result.output, /Useful page/);
  assert.doesNotMatch(result.output, /ignored/);

  const tooLarge = new WebTools({
    lookup: publicLookup(),
    fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, text: async () => 'x'.repeat(2 * 1024 * 1024 + 1) }),
  });
  await assert.rejects(() => tooLarge.tools.webfetch.run({ url: 'https://public.example/large' }), /2 MiB download limit/);
});
