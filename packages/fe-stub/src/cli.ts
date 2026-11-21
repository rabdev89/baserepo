#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CONFIG_FILE, collectStubs, findShadowed, loadConfig, type Config } from './loader.js';
import { ADMIN_PATH, startStubServer } from './server.js';

const HELP = `fe-stub — a local stub API for any frontend (React, Angular, Vue, ...)

Usage
  fe-stub serve [opts]                    Start the stub API
  fe-stub run [opts] -- <dev command>     Start the stub API, then your dev server
  fe-stub init                            Create stubs/ with examples and ${CONFIG_FILE}
  fe-stub validate [opts]                 Check stub files, exit 1 on errors
  fe-stub list [opts]                     Print the stubbed endpoints

Options
  --port <n>       Port of the stub API              (default: 3001)
  --dir <path>     Stub folder                       (default: stubs)
  --target <url>   Forward unmatched calls to a real API (default: none, 404)
  --host <host>    Interface to bind                 (default: localhost = this machine only)
  --env <NAME>     run only: also set env var NAME to the stub API URL (repeatable)

Every option can also be set in ${CONFIG_FILE}.

Example package.json scripts
  "start":      "ng serve"
  "start:stub": "fe-stub run -- ng serve --proxy-config proxy.stub.json"
`;

interface Args {
  command?: string;
  cfg: Partial<Config>;
  env: string[];
  rest: string[];
}

function parseArgs(argv: string[]): Args {
  const sep = argv.indexOf('--');
  const own = sep === -1 ? argv : argv.slice(0, sep);
  const args: Args = { cfg: {}, env: [], rest: sep === -1 ? [] : argv.slice(sep + 1) };
  const value = (i: number, flag: string) => {
    const v = own[i];
    if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (a === '--port') {
      const n = Number(value(++i, a));
      if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`Invalid --port "${own[i]}"`);
      args.cfg.port = n;
    } else if (a === '--dir') args.cfg.dir = value(++i, a);
    else if (a === '--target') args.cfg.target = value(++i, a);
    else if (a === '--host') args.cfg.host = value(++i, a);
    else if (a === '--env') args.env.push(value(++i, a));
    else if (a === '-h' || a === '--help') args.command = 'help';
    else if (!args.command) args.command = a;
    else fail(`Unknown argument: ${a}`);
  }
  return args;
}

const cwd = process.cwd();
const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(cwd, args.cfg);

switch (args.command) {
  case 'serve': await serve(cfg); break;
  case 'run': await run(cfg, args.rest, args.env); break;
  case 'init': init(cfg); break;
  case 'validate': validate(cfg); break;
  case 'list': list(cfg); break;
  case undefined:
  case 'help': console.log(HELP); break;
  default: fail(`Unknown command "${args.command}"\n\n${HELP}`);
}

async function start(c: Config) {
  const { stubs, errors } = collectStubs(c.dir, cwd);
  errors.forEach((e) => console.error(`[fe-stub] ✖ ${e}`));
  if (errors.length) process.exit(1);
  findShadowed(stubs).forEach((w) => console.warn(`[fe-stub] ⚠ ${w}`));

  try {
    const server = await startStubServer({
      dir: c.dir, port: c.port, host: c.host, target: c.target, cwd,
      log: (l) => console.log(`[fe-stub] ${l}`),
    });
    console.log(`[fe-stub] stub API on ${server.url} · ${server.stubs.length} stub(s) from ${c.dir}/`
      + `${c.target ? ` · unmatched → ${c.target}` : ''} · list: ${server.url}${ADMIN_PATH}`);
    return server;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') fail(`Port ${c.port} is already in use. Pick another with --port.`);
    fail(e.message);
  }
}

async function serve(c: Config): Promise<void> {
  const server = await start(c);
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function run(c: Config, command: string[], envNames: string[]): Promise<void> {
  if (!command.length) fail('Missing dev command. Example: fe-stub run -- npm start');
  const server = await start(c);

  const env: NodeJS.ProcessEnv = { ...process.env, FE_STUB: 'true', FE_STUB_URL: server.url, FE_STUB_PORT: String(server.port) };
  for (const name of envNames) env[name] = server.url;

  const child = spawn(command.join(' '), { stdio: 'inherit', shell: true, env });
  let stopping = false;
  const stop = (sig: NodeJS.Signals) => () => {
    if (stopping) return;
    stopping = true;
    child.kill(sig);
  };
  process.on('SIGINT', stop('SIGINT'));
  process.on('SIGTERM', stop('SIGTERM'));
  child.on('exit', async (code, signal) => {
    await server.close();
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
  for (const r of [head, ...rows]) console.log(r.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd());
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

  const write = (path: string, content: unknown) => {
    if (existsSync(path)) { console.log(`• exists  ${relative(cwd, path)}`); return; }
    writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
    console.log(`✔ created ${relative(cwd, path)}`);
  };
  for (const [name, content] of Object.entries(files)) write(join(dir, name), content);
  write(join(cwd, CONFIG_FILE), { dir: c.dir, port: c.port });

  const isAngular = existsSync(join(cwd, 'angular.json'));
  if (isAngular) {
    write(join(cwd, 'proxy.stub.json'), { '/api': { target: `http://localhost:${c.port}`, secure: false, logLevel: 'info' } });
  }

  console.log(`
Next steps
  1. Add a script to package.json:
       ${isAngular
    ? '"start:stub": "fe-stub run -- ng serve --proxy-config proxy.stub.json"'
    : '"start:stub": "fe-stub run -- <your dev command>"   (see README for Vite / CRA)'}
  2. npm run start:stub
  3. Stub API: http://localhost:${c.port}${ADMIN_PATH}
`);
}

function fail(msg: string): never {
  console.error(`[fe-stub] ${msg}`);
  process.exit(1);
}
