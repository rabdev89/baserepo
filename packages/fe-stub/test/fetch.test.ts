import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStubs } from '../src/matcher.js';
import { patchFetch } from '../src/fetch.js';

const stubs = compileStubs([
  { method: 'POST', endpoint: '/api/users', response: { status: 201, body: { name: '{{body.name}}' }, headers: { 'x-stub': '1' } } },
  { endpoint: '/api/slow', response: { delay: 200, body: 'late' } },
]);

function host() {
  const calls: string[] = [];
  const h = {
    location: { href: 'http://localhost:3000/' },
    fetch: (async (input: RequestInfo | URL) => { calls.push(String(input)); return new Response('real'); }) as typeof fetch,
  };
  return { h, calls };
}

test('stubbed POST returns stub response; others go to real fetch', async () => {
  const { h, calls } = host();
  const hits: string[] = [];
  const undo = patchFetch(h, () => stubs, (_r, hit) => hits.push(hit.stub.name));

  const res = await h.fetch('/api/users', { method: 'POST', body: JSON.stringify({ name: 'Ada' }) });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('x-stub'), '1');
  assert.deepEqual(await res.json(), { name: 'Ada' });

  const viaRequest = await h.fetch(new Request('http://localhost:3000/api/users', { method: 'POST', body: '{"name":"Bob"}' }));
  assert.deepEqual(await viaRequest.json(), { name: 'Bob' });

  const real = await h.fetch('/api/other');
  assert.equal(await real.text(), 'real');
  assert.deepEqual(calls, ['/api/other']);
  assert.equal(hits.length, 2);

  undo();
  await h.fetch('/api/users', { method: 'POST' });
  assert.equal(calls.length, 2);
});

test('delay respects AbortSignal', async () => {
  const { h } = host();
  patchFetch(h, () => stubs, () => {});
  const ac = new AbortController();
  const p = h.fetch('/api/slow', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
});
