import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupStub } from '../src/index.js';

const realFetch = globalThis.fetch;
let bundle: unknown;
let storage: Map<string, string>;

function installWindow(href: string) {
  storage = new Map();
  const url = new URL(href);
  const win = {
    location: { href, hostname: url.hostname, search: url.search, reload() {} },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input) === '/__stubs__.json') {
        return bundle ? Response.json(bundle) : new Response('nope', { status: 404 });
      }
      return new Response('real');
    }) as typeof fetch,
  };
  (globalThis as Record<string, unknown>).window = win;
  return win;
}

beforeEach(() => { bundle = { enabled: true, stubs: [{ endpoint: '/api/x', response: { body: { stub: true } } }] }; });
afterEach(() => { delete (globalThis as Record<string, unknown>).window; globalThis.fetch = realFetch; });

const opts = { badge: false, log: false, xhr: false } as const;

test('active on localhost when bundle enabled', async () => {
  const win = installWindow('http://localhost:5173/');
  const c = await setupStub(opts);
  assert.equal(c.active, true);
  assert.deepEqual(await (await win.fetch('/api/x')).json(), { stub: true });
  c.uninstall();
  assert.equal(await (await win.fetch('/api/x')).text(), 'real');
});

test('never active on non-local hosts', async () => {
  installWindow('https://myapp.com/?stub=on');
  assert.equal((await setupStub({ ...opts, enabled: true })).active, false);
});

test('inactive when bundle disabled or missing', async () => {
  installWindow('http://localhost:4200/');
  bundle = { enabled: false, stubs: [] };
  assert.equal((await setupStub(opts)).active, false);
  bundle = undefined;
  assert.equal((await setupStub(opts)).active, false);
});

test('?stub=on / ?stub=off toggles and is remembered', async () => {
  installWindow('http://localhost:4200/?stub=off');
  assert.equal((await setupStub(opts)).active, false);
  assert.equal(storage.get('fe-stub'), 'off');

  installWindow('http://localhost:4200/?stub=on');
  bundle = { enabled: false, stubs: [{ endpoint: '/a', response: {} }] };
  assert.equal((await setupStub(opts)).active, true);
});

test('inline stubs without a bundle', async () => {
  const win = installWindow('http://127.0.0.1:3000/');
  const c = await setupStub({ ...opts, stubs: [{ method: 'POST', endpoint: '/api/y', response: { status: 202 } }] });
  assert.equal(c.active, true);
  assert.equal((await win.fetch('/api/y', { method: 'POST' })).status, 202);
});
