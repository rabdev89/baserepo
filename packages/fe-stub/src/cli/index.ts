#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  CONFIG_FILE, collectStubs, findShadowed, loadConfig, writeBundle, type Config,
} from './bundle.js';

const HELP = `fe-stub — local HTTP stubs for any frontend (React, Angular, Vue, ...)

Usage
  fe-stub init                      Create stubs/ with examples and ${CONFIG_FILE}
  fe-stub run [opts] -- <command>   Build bundle with stubs ON, watch for changes, run <command>
  fe-stub build [opts] [--enabled]  Write the bundle once (stubs OFF unless --enabled)
  fe-stub validate [opts]           Check stub files, exit 1 on errors
  fe-stub list [opts]               Print the stubbed endpoints

Options
  --dir <path>   Stub folder           (default: stubs)
  --out <path>   Bundle output file    (default: public/__stubs__.json)

Example package.json scripts
  "start":      "ng serve"                        (or "vite", "react-scripts start")
  "start:stub": "fe-stub run -- ng serve"
`;

interface Args {
  command: string | undefined;
  dir?: string;
  out?: string;
  enabled: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  const args: Args = { command: undefined, enabled: false, rest };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--dir') args.dir = own[++i];
    else if (a === '--out') args.out = own[++i];
    else if (a === '--enabled') args.enabled = true;
    else if (a === '-h' || a === '--help') args.command = 'help';
    else if (!args.command) args.command = a;
    else if (args.command === 'run') args.rest.unshift(...own.slice(i)), (i = own.length);
    else fail(`Unknown argument: ${a}`);
  }
  return args;
}

const cwd = process.cwd();
const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(cwd, { dir: args.dir, out: args.out });

switch (args.command) {
  case 'init': init(cfg); break;
  case 'build': build(cfg, args.enabled, true); break;
  case 'run': run(cfg, args.rest); break;
  case 'validate': validate(cfg); break;
  case 'list': list(cfg); break;
  case undefined:
  case 'help': console.log(HELP); break;
  default: fail(`Unknown command "${args.command}"\n\n${HELP}`);
}

function build(c: Config, enabled: boolean, exitOnError: boolean): boolean {
  const { stubs, errors } = collectStubs(c.dir, cwd);
  errors.forEach((e) => console.error(`[fe-stub] ✖ ${e}`));
  if (errors.length && exitOnError) process.exit(1);
  const path = writeBundle(c.out, stubs, enabled, cwd);
  console.log(`[fe-stub] ${stubs.length} stub(s) → ${relative(cwd, path)} (${enabled ? 'ON' : 'OFF'})`);
  return errors.length === 0;
}

function run(c: Config, command: string[]): void {
  if (!command.length) fail('Missing command. Example: fe-stub run -- npm start');
  build(c, true, false);

  // Rebuild when stub files change, so edits show up on the next request (no restart).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dir = resolve(cwd, c.dir);
  const watcher = existsSync(dir)
    ? watch(dir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => build(c, true, false), 100);
    })
    : null;

  const child = spawn(command.join(' '), { stdio: 'inherit', shell: true, env: { ...process.env, FE_STUB: 'true' } });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    watcher?.close();
    clearTimeout(timer);
    // Leave the file in place but switched OFF, so a plain `npm start` is never stubbed.
    try { build(c, false, false); } catch { /* ignore */ }
  };
  const forward = (sig: NodeJS.Signals) => () => { cleanup(); child.kill(sig); };
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    cleanup();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

function validate(c: Config): void {
  const { stubs, errors, dataFiles } = collectStubs(c.dir, cwd);
  const warnings = findShadowed(stubs);
  errors.forEach((e) => console.error(`✖ ${e}`));
  warnings.forEach((w) => console.warn(`⚠ ${w}`));
  if (dataFiles.length) console.log(`ℹ ${dataFiles.length} data file(s) skipped (not stubs): ${dataFiles.join(', ')}`);
  console.log(`${errors.length ? '✖' : '✔'} ${stubs.length} stub(s), ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length ? 1 : 0);
}

function list(c: Config): void {
  const { stubs, errors } = collectStubs(c.dir, cwd);
  errors.forEach((e) => console.error(`✖ ${e}`));
  const rows = stubs.map((s) => [
    s.enabled === false ? 'off' : 'on',
    (s.method ?? 'GET').toUpperCase(),
    s.endpoint,
    String(s.response.status ?? 200),
    s.name ?? '',
  ]);
  const head = ['', 'METHOD', 'ENDPOINT', 'STATUS', 'NAME'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  for (const r of [head, ...rows]) console.log(r.map((v, i) => v.padEnd(widths[i])).join('  '));
}

function init(c: Config): void {
  const dir = resolve(cwd, c.dir);
  mkdirSync(join(dir, 'responses'), { recursive: true });

  const files: Record<string, unknown> = {
    'auth.json': [
      {
        name: 'Login OK',
        method: 'POST',
        endpoint: '/api/auth/login',
        match: { body: { email: 'demo@example.com' } },
        response: { status: 200, delay: 300, body: { token: 'stub-token', user: { email: '{{body.email}}' } } },
      },
      {
        name: 'Login rejected',
        method: 'POST',
        endpoint: '/api/auth/login',
        response: { status: 401, body: { message: 'Invalid credentials' } },
      },
    ],
    'users.json': [
      { name: 'List users', method: 'GET', endpoint: '/api/users', response: { status: 200, bodyFile: 'responses/users.json' } },
      { name: 'Get user', method: 'GET', endpoint: '/api/users/:id', response: { status: 200, body: { id: '{{params.id}}', name: 'Stub User' } } },
      { name: 'Create user', method: 'POST', endpoint: '/api/users', response: { status: 201, body: { id: 99, name: '{{body.name}}' } } },
    ],
    'responses/users.json': [{ id: 1, name: 'Ada' }, { id: 2, name: 'Linus' }],
  };

  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    if (existsSync(path)) { console.log(`• exists  ${relative(cwd, path)}`); continue; }
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
    console.log(`✔ created ${relative(cwd, path)}`);
  }

  const cfgPath = join(cwd, CONFIG_FILE);
  if (!existsSync(cfgPath)) {
    writeFileSync(cfgPath, `${JSON.stringify({ dir: c.dir, out: c.out }, null, 2)}\n`);
    console.log(`✔ created ${CONFIG_FILE}`);
  }

  const gi = join(cwd, '.gitignore');
  if (existsSync(gi) && !readFileSync(gi, 'utf8').split(/\r?\n/).includes(c.out)) {
    appendFileSync(gi, `\n# fe-stub generated bundle\n${c.out}\n`);
    console.log(`✔ added ${c.out} to .gitignore`);
  }

  console.log(`
Next steps
  1. Add a script:   "start:stub": "fe-stub run -- <your dev command>"
  2. In main.ts(x), before bootstrapping:
       import { setupStub } from 'fe-stub';
       await setupStub();
  3. npm run start:stub
`);
}

function fail(msg: string): never {
  console.error(`[fe-stub] ${msg}`);
  process.exit(1);
}
