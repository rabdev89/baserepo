import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStubs } from '../src/matcher.js';
import { patchXhr } from '../src/xhr.js';

/** Minimal stand-in for the browser XMLHttpRequest. */
class FakeXHR extends EventTarget {
  static sent: string[] = [];
  readyState = 0;
  status = 0;
  responseType: XMLHttpRequestResponseType = '';
  [k: string]: unknown;
  open(_m: string, _u: string) { this.readyState = 1; }
  setRequestHeader(_n: string, _v: string) {}
  send(_b?: unknown) { FakeXHR.sent.push('real'); }
  abort() {}
  override dispatchEvent(ev: Event): boolean {
    const handler = this[`on${ev.type}`];
    if (typeof handler === 'function') handler.call(this, ev);
    return super.dispatchEvent(ev);
  }
}

const stubs = compileStubs([
  { method: 'POST', endpoint: '/api/login', match: { body: { user: 'a' } }, response: { status: 200, body: { ok: true }, headers: { 'X-Id': '9' } } },
]);
const host = { XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest, location: { href: 'http://localhost:4200/' } };
patchXhr(host, () => stubs, () => {});

function request(body: string, responseType: XMLHttpRequestResponseType = ''): Promise<XMLHttpRequest> {
  return new Promise((resolve) => {
    const xhr = new host.XMLHttpRequest();
    xhr.responseType = responseType;
    xhr.open('POST', '/api/login');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.addEventListener('load', () => resolve(xhr));
    xhr.send(body);
    if (FakeXHR.sent.length) resolve(xhr);
  });
}

test('XHR stub fires load with status, headers, text (axios style)', async () => {
  let readyStates: number[] = [];
  const xhr = await new Promise<XMLHttpRequest>((resolve) => {
    const x = new host.XMLHttpRequest();
    x.onreadystatechange = () => { readyStates.push(x.readyState); if (x.readyState === 4) resolve(x); };
    x.open('POST', '/api/login');
    x.send('{"user":"a"}');
  });
  assert.deepEqual(readyStates, [2, 4]);
  assert.equal(xhr.status, 200);
  assert.equal(xhr.getResponseHeader('x-id'), '9');
  assert.match(xhr.getAllResponseHeaders(), /content-type: application\/json/);
  assert.equal(xhr.responseText, '{"ok":true}');
  assert.equal(xhr.responseURL, 'http://localhost:4200/api/login');
});

test('XHR responseType json (Angular HttpClient style)', async () => {
  const xhr = await request('{"user":"a"}', 'json');
  assert.deepEqual(xhr.response, { ok: true });
});

test('unmatched XHR goes to the real send', async () => {
  FakeXHR.sent = [];
  await request('{"user":"zzz"}');
  assert.deepEqual(FakeXHR.sent, ['real']);
});
