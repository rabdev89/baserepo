import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStubServer } from '../src/server.js';

const quiet = { log: false } as const;

test('serves stubs over real HTTP', async () => {
  const s = await startStubServer({
    ...quiet,
    port: 0,
    stubs: [
      { method: 'POST', endpoint: '/api/users', match: { body: { role: 'admin' } }, response: { status: 403, body: { message: 'no admins' } } },
      { method: 'POST', endpoint: '/api/users', response: { status: 201, headers: { 'x-request-id': 'abc' }, body: { name: '{{body.name}}' } } },
      { endpoint: '/api/users/:id', response: { body: { id: '{{params.id}}', page: '{{query.page}}' } } },
      { method: 'DELETE', endpoint: '/api/users/:id', response: { status: 204 } },
      { method: 'POST', endpoint: '/api/form', match: { body: { a: '1' } }, response: { body: 'form ok' } },
    ],
  });
  try {
    const created = await fetch(`${s.url}/api/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ada' }) });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('x-request-id'), 'abc');
    assert.deepEqual(await created.json(), { name: 'Ada' });

    const admin = await fetch(`${s.url}/api/users`, { method: 'POST', body: JSON.stringify({ name: 'x', role: 'admin' }) });
    assert.equal(admin.status, 403);

    assert.deepEqual(await (await fetch(`${s.url}/api/users/7?page=2`)).json(), { id: '7', page: '2' });
    assert.equal((await fetch(`${s.url}/api/users/7`, { method: 'DELETE' })).status, 204);

    const form = await fetch(`${s.url}/api/form`, { method: 'POST', body: new URLSearchParams({ a: '1' }) });
    assert.equal(await form.text(), 'form ok');

    const missing = await fetch(`${s.url}/api/nope`);
    assert.equal(missing.status, 404);
    assert.match(((await missing.json()) as { error: string }).error, /no stub matches GET \/api\/nope/);

    const admin2 = (await (await fetch(`${s.url}/__fe-stub`)).json()) as { stubs: unknown[] };
    assert.equal(admin2.stubs.length, 5);
  } finally {
    await s.close();
  }
});

test('CORS: preflight + headers so the browser can call it directly', async () => {
  const s = await startStubServer({ ...quiet, port: 0, stubs: [{ method: 'POST', endpoint: '/a', response: { headers: { 'x-id': '1' }, body: {} } }] });
  try {
    const pre = await fetch(`${s.url}/a`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:4200', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:4200');
    assert.equal(pre.headers.get('access-control-allow-headers'), 'content-type,authorization');

    const res = await fetch(`${s.url}/a`, { method: 'POST', headers: { origin: 'http://localhost:4200' } });
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /x-id/);
  } finally {
    await s.close();
  }
});

test('unmatched calls are forwarded to --target', async () => {
  const seen: string[] = [];
  const real = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': 'https://real.example' });
      res.end(JSON.stringify({ real: true }));
    });
  });
  await new Promise<void>((r) => real.listen(0, '127.0.0.1', r));
  const realPort = (real.address() as { port: number }).port;

  const s = await startStubServer({ ...quiet, port: 0, target: `http://127.0.0.1:${realPort}/base`, stubs: [{ endpoint: '/api/stubbed', response: { body: { stub: true } } }] });
  try {
    assert.deepEqual(await (await fetch(`${s.url}/api/stubbed`)).json(), { stub: true });

    const fwd = await fetch(`${s.url}/api/live?x=1`, { method: 'POST', body: 'hello', headers: { origin: 'http://localhost:4200' } });
    assert.deepEqual(await fwd.json(), { real: true });
    assert.equal(fwd.headers.get('access-control-allow-origin'), 'http://localhost:4200'); // ours, not upstream's
    assert.deepEqual(seen, ['POST /base/api/live?x=1 hello']);
  } finally {
    await s.close();
    real.close();
  }
});

test('target down → 502', async () => {
  const s = await startStubServer({ ...quiet, port: 0, target: 'http://127.0.0.1:1', stubs: [] });
  try {
    assert.equal((await fetch(`${s.url}/x`)).status, 502);
  } finally {
    await s.close();
  }
});

test('reloads when stub files change; keeps old stubs if new ones are broken', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  mkdirSync(join(cwd, 'stubs'));
  const file = join(cwd, 'stubs/a.json');
  writeFileSync(file, JSON.stringify({ endpoint: '/v', response: { body: 1 } }));
  const logs: string[] = [];
  const s = await startStubServer({ cwd, port: 0, log: (l) => logs.push(l) });
  const get = async () => (await fetch(`${s.url}/v`)).json();
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    assert.equal(await get(), 1);
    writeFileSync(file, JSON.stringify({ endpoint: '/v', response: { body: 2 } }));
    await waitFor(() => logs.some((l) => l.includes('reloaded')));
    assert.equal(await get(), 2);

    writeFileSync(file, '{ broken');
    await waitFor(() => logs.some((l) => l.includes('keeping previous')));
    assert.equal(await get(), 2);
  } finally {
    await s.close();
  }
});

test('binds to localhost only by default (IPv4 and IPv6 loopback)', async () => {
  const s = await startStubServer({ ...quiet, port: 0, stubs: [{ endpoint: '/x', response: { body: 'ok' } }] });
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${s.port}/x`)).text(), 'ok');
    try {
      assert.equal(await (await fetch(`http://[::1]:${s.port}/x`)).text(), 'ok');
    } catch { /* no IPv6 on this machine */ }
  } finally {
    await s.close();
  }
});
