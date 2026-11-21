import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('.test-build/src/cli/index.js');
const node = (cwd: string, ...a: string[]) => execFileSync(process.execPath, [CLI, ...a], { cwd, encoding: 'utf8' });

test('init → validate → build → run', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n');

  node(cwd, 'init');
  assert.match(readFileSync(join(cwd, '.gitignore'), 'utf8'), /public\/__stubs__\.json/);
  assert.match(node(cwd, 'validate'), /✔ 5 stub\(s\), 0 error/);
  assert.match(node(cwd, 'list'), /POST\s+\/api\/auth\/login\s+401/);

  node(cwd, 'build');
  const off = JSON.parse(readFileSync(join(cwd, 'public/__stubs__.json'), 'utf8'));
  assert.equal(off.enabled, false);
  const users = off.stubs.find((s: { name: string }) => s.name === 'List users');
  assert.deepEqual(users.response.body, [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }]); // bodyFile inlined

  // While the wrapped command runs the bundle is ON; afterwards it is switched OFF.
  const probe = `node -e "console.log('ENABLED=' + JSON.parse(require('fs').readFileSync('public/__stubs__.json','utf8')).enabled)"`;
  const out = node(cwd, 'run', '--', probe);
  assert.match(out, /ENABLED=true/);
  assert.equal(JSON.parse(readFileSync(join(cwd, 'public/__stubs__.json'), 'utf8')).enabled, false);
});

test('validate reports bad stubs', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  mkdirSync(join(cwd, 'stubs'));
  writeFileSync(join(cwd, 'stubs/bad.json'), '[{"endpoint":"/a"}]');
  writeFileSync(join(cwd, 'stubs/broken.json'), '{ nope');
  assert.throws(() => node(cwd, 'validate'), (e: { status: number; stderr: string }) =>
    e.status === 1 && /missing "response"/.test(e.stderr) && /invalid JSON/.test(e.stderr));
});

test('validate warns when a generic stub hides a specific one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fe-stub-'));
  mkdirSync(join(cwd, 'stubs'));
  writeFileSync(join(cwd, 'stubs/a.json'), JSON.stringify([
    { name: 'generic', method: 'POST', endpoint: '/a', response: {} },
    { name: 'specific', method: 'POST', endpoint: '/a', match: { body: { x: 1 } }, response: {} },
  ]));
  const out = execFileSync(process.execPath, [CLI, 'validate'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /1 warning/);
});
