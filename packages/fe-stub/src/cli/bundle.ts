import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { compileStub } from '../matcher.js';
import type { Stub, StubBundle } from '../types.js';

export interface Config {
  /** Folder that holds the stub JSON files. */
  dir: string;
  /** Where the bundle is written. Must be served by your dev server (public/ or src/assets/). */
  out: string;
}

export const DEFAULT_CONFIG: Config = { dir: 'stubs', out: 'public/__stubs__.json' };
export const CONFIG_FILE = 'fe-stub.config.json';

export function loadConfig(cwd: string, overrides: Partial<Config>): Config {
  let fileCfg: Partial<Config> = {};
  const path = join(cwd, CONFIG_FILE);
  if (existsSync(path)) fileCfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  return { ...DEFAULT_CONFIG, ...fileCfg, ...clean };
}

export interface CollectResult {
  stubs: Array<Stub & { _file: string }>;
  /** JSON files that are not stub definitions (e.g. bodyFile payloads). */
  dataFiles: string[];
  errors: string[];
}

/** Read every *.json under `dir`. A file is a stub file if it is a stub, an array of stubs, or { stubs: [...] }. */
export function collectStubs(dir: string, cwd = process.cwd()): CollectResult {
  const root = resolve(cwd, dir);
  const result: CollectResult = { stubs: [], dataFiles: [], errors: [] };
  if (!existsSync(root)) {
    result.errors.push(`Stub folder not found: ${relative(cwd, root) || root}`);
    return result;
  }

  for (const file of walk(root)) {
    const rel = relative(cwd, file);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      result.errors.push(`${rel}: invalid JSON (${(e as Error).message})`);
      continue;
    }

    const list = asStubList(data);
    if (!list) {
      result.dataFiles.push(rel);
      continue;
    }

    list.forEach((stub, i) => {
      try {
        const inlined = inlineBodyFile(stub, dirname(file), cwd);
        compileStub(inlined, i); // validates
        result.stubs.push({ ...inlined, _file: rel });
      } catch (e) {
        result.errors.push(`${rel}: ${(e as Error).message.replace('[fe-stub] ', '')}`);
      }
    });
  }
  return result;
}

export function writeBundle(out: string, stubs: Stub[], enabled: boolean, cwd = process.cwd()): string {
  const path = resolve(cwd, out);
  mkdirSync(dirname(path), { recursive: true });
  const bundle: StubBundle = {
    enabled,
    generatedAt: new Date().toISOString(),
    stubs: stubs.map(({ _file, ...s }: Stub & { _file?: string }) => s),
  };
  writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
  return path;
}

/**
 * First match wins. Once a stub without `match` rules is seen, any later stub
 * with the same method + endpoint can never be hit.
 */
export function findShadowed(stubs: Array<Stub & { _file: string }>): string[] {
  const catchAll = new Map<string, Stub & { _file: string }>();
  const warnings: string[] = [];
  for (const s of stubs) {
    if (s.enabled === false) continue;
    const key = `${(s.method ?? 'GET').toUpperCase()} ${s.endpoint}`;
    const prev = catchAll.get(key);
    if (prev) {
      warnings.push(`"${s.name ?? key}" (${s._file}) is never used: "${prev.name ?? key}" (${prev._file}) matches first. Put specific stubs before generic ones.`);
    } else if (!s.match) {
      catchAll.set(key, s);
    }
  }
  return warnings;
}

function asStubList(data: unknown): Stub[] | null {
  const isStub = (v: unknown): v is Stub => !!v && typeof v === 'object' && 'endpoint' in v;
  if (Array.isArray(data)) return data.length > 0 && data.every(isStub) ? data : null;
  if (isStub(data)) return [data];
  if (data && typeof data === 'object' && Array.isArray((data as { stubs?: unknown }).stubs)) {
    return (data as { stubs: Stub[] }).stubs;
  }
  return null;
}

function inlineBodyFile(stub: Stub, baseDir: string, cwd: string): Stub {
  const bodyFile = stub.response?.bodyFile;
  if (!bodyFile) return stub;
  const path = resolve(baseDir, bodyFile);
  if (!existsSync(path)) throw new Error(`bodyFile not found: ${relative(cwd, path)}`);
  const text = readFileSync(path, 'utf8');
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  const { bodyFile: _drop, ...response } = stub.response;
  return { ...stub, response: { ...response, body } };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.json')) out.push(full);
  }
  return out;
}
