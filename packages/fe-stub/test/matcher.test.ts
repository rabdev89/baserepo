import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileStubs, findStub, partialMatch, pathToRegex, resolveResponse } from '../src/matcher.js';

const stubs = compileStubs([
  { name: 'login ok', method: 'POST', endpoint: '/api/login', match: { body: { email: 'a@b.c' } }, response: { status: 200, body: { token: 't', email: '{{body.email}}' } } },
  { name: 'login fail', method: 'post', endpoint: '/api/login', response: { status: 401, body: { message: 'no' } } },
  { name: 'user', endpoint: '/api/users/:id', response: { body: { id: '{{params.id}}', label: 'User {{params.id}}' } } },
  { name: 'page2', endpoint: '/api/items', match: { query: { page: 2 } }, response: { body: ['p2'] } },
  { name: 'items', endpoint: '/api/items', response: { body: ['p1'] } },
  { name: 'disabled', endpoint: '/api/off', enabled: false, response: { body: 1 } },
  { name: 'abs', endpoint: 'https://api.example.com/v1/ping', response: { body: 'pong' } },
  { name: 'wild', method: '*', endpoint: '/api/files/*', response: { status: 204 } },
  { name: 'hdr', endpoint: '/api/me', match: { headers: { Authorization: 'Bearer x' } }, response: { body: { me: true } } },
]);

test('matches method + path + body', () => {
  assert.equal(findStub(stubs, { method: 'POST', url: '/api/login', body: '{"email":"a@b.c","pw":"x"}' })?.stub.name, 'login ok');
  assert.equal(findStub(stubs, { method: 'POST', url: '/api/login', body: '{"email":"z"}' })?.stub.name, 'login fail');
  assert.equal(findStub(stubs, { method: 'GET', url: '/api/login' }), null);
});

test('path params, query, absolute urls, wildcard, disabled', () => {
  assert.deepEqual(findStub(stubs, { url: 'http://localhost:4200/api/users/42/' })?.params, { id: '42' });
  assert.equal(findStub(stubs, { url: '/api/items?page=2' })?.stub.name, 'page2');
  assert.equal(findStub(stubs, { url: '/api/items?page=1' })?.stub.name, 'items');
  assert.equal(findStub(stubs, { url: '/api/off' }), null);
  assert.equal(findStub(stubs, { url: 'https://api.example.com/v1/ping' })?.stub.name, 'abs');
  assert.equal(findStub(stubs, { url: 'https://other.com/v1/ping' }), null);
  assert.equal(findStub(stubs, { method: 'DELETE', url: '/api/files/a/b.txt' })?.stub.name, 'wild');
});

test('header matching (Headers or plain object)', () => {
  assert.equal(findStub(stubs, { url: '/api/me', headers: { authorization: 'Bearer x' } })?.stub.name, 'hdr');
  assert.equal(findStub(stubs, { url: '/api/me', headers: new Headers({ Authorization: 'Bearer x' }) })?.stub.name, 'hdr');
  assert.equal(findStub(stubs, { url: '/api/me' }), null);
});

test('resolveResponse renders templates and sets content-type', () => {
  const req = { url: '/api/users/7' };
  const res = resolveResponse(findStub(stubs, req)!, req);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.bodyText!), { id: '7', label: 'User 7' });

  const del = { method: 'DELETE', url: '/api/files/x' };
  assert.equal(resolveResponse(findStub(stubs, del)!, del).bodyText, null);
});

test('helpers', () => {
  assert.ok(partialMatch({ a: { b: 1 } }, { a: { b: 1, c: 2 }, d: 3 }));
  assert.ok(!partialMatch({ a: [1] }, { a: [1, 2] }));
  assert.ok(pathToRegex('/a/:x').regex.test('/a/1/'));
  assert.throws(() => compileStubs([{ endpoint: '' } as never]), /endpoint/);
});
