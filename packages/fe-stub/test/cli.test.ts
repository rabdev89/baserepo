import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('.test-build/src/cli.js');
const cli = (cwd: string, ...a: string[]) =>
  execFileSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('init → validate → list', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  writeFileSync(join(cwd, 'angular.json'), '{}');
  cli(cwd, 'init');
  assert.ok(existsSync(join(cwd, 'stubs/users.json')));
  assert.deepEqual(JSON.parse(readFileSync(join(cwd, 'fe-stub.config.json'), 'utf8')), { dir: 'stubs', port: 3001 });
  assert.equal(JSON.parse(readFileSync(join(cwd, 'proxy.stub.json'), 'utf8'))['/api'].target, 'http://localhost:3001');
  assert.match(cli(cwd, 'validate'), /✔ 5 stub\(s\), 0 error/);
  assert.match(cli(cwd, 'list'), /POST\s+\/api\/auth\/login\s+401/);
});

test('run: stub API is up while the dev command runs, env vars are set', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  cli(cwd, 'init');
  // Stand-in for "ng serve": calls the stub API, prints what it got, exits.
  writeFileSync(join(cwd, 'probe.mjs'), `
    const r = await fetch(process.env.FE_STUB_URL + '/api/users/5');
    console.log('GOT', JSON.stringify(await r.json()), process.env.VITE_API_URL === process.env.FE_STUB_URL);
  `);
  const out = cli(cwd, 'run', '--port', '0', '--env', 'VITE_API_URL', '--', 'node probe.mjs');
  assert.match(out, /GOT {"id":"5","name":"Stub User"} true/);
  assert.match(out, /GET\s+\/api\/users\/5 → 200 stub "Get user"/);
});

test('run passes the dev command exit code through', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  cli(cwd, 'init');
  assert.throws(() => cli(cwd, 'run', '--port', '0', '--', 'node -e "process.exit(3)"'), { status: 3 });
});

test('validate reports bad stubs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  mkdirSync(join(cwd, 'stubs'));
  writeFileSync(join(cwd, 'stubs/bad.json'), '[{"endpoint":"/a"}]');
  writeFileSync(join(cwd, 'stubs/broken.json'), '{ nope');
  assert.throws(() => cli(cwd, 'validate'), (e: { status: number; stderr: string }) =>
    e.status === 1 && /missing "response"/.test(e.stderr) && /invalid JSON/.test(e.stderr));
});

test('validate warns when a generic stub hides a specific one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  mkdirSync(join(cwd, 'stubs'));
  writeFileSync(join(cwd, 'stubs/a.json'), JSON.stringify([
    { name: 'generic', method: 'POST', endpoint: '/a', response: {} },
    { name: 'specific', method: 'POST', endpoint: '/a', match: { body: { x: 1 } }, response: {} },
  ]));
  assert.match(cli(cwd, 'validate'), /1 warning/);
});
