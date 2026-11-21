import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { compileStubs, findStub, resolveResponse } from './matcher.js';
import { collectStubs } from './loader.js';
import type { CompiledStub, ServerOptions, StubServer } from './types.js';

export const ADMIN_PATH = '/__fe-stub';

/**
 * Start a local HTTP server that answers from stub files.
 * Unmatched requests go to `target` (if set) or get a 404.
 */
export async function startStubServer(options: ServerOptions = {}): Promise<StubServer> {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? 'stubs';
  const cors = options.cors !== false;
  const target = options.target ? new URL(options.target) : null;
  const log = options.log === false ? () => {} : typeof options.log === 'function' ? options.log : console.log;

  let stubs: CompiledStub[] = [];
  const reload = () => {
    if (options.stubs) {
      stubs = compileStubs(options.stubs);
      return;
    }
    const { stubs: raw, errors } = collectStubs(dir, cwd);
    if (errors.length) throw new Error(errors.join('\n'));
    stubs = compileStubs(raw);
  };
  reload();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';
    const line = (status: number | string, what: string) =>
      log(`${pad(method)} ${url} → ${status} ${what} (${Date.now() - started}ms)`);

    try {
      if (cors) applyCors(req, res);

      // CORS preflight: answer it ourselves unless a stub explicitly handles OPTIONS.
      if (cors && method === 'OPTIONS' && req.headers['access-control-request-method']
        && !stubs.some((s) => s.enabled && s.method === 'OPTIONS')) {
        res.writeHead(204).end();
        return;
      }

      if (url.split('?')[0] === ADMIN_PATH) {
        sendJson(res, 200, {
          target: target?.href ?? null,
          stubs: stubs.map((s) => ({ name: s.name, method: s.method, endpoint: s.endpoint, enabled: s.enabled, status: s.response.status })),
        });
        return;
      }

      const raw = await readBody(req);
      const stubReq = { method, url, headers: req.headers, body: decodeBody(raw, req.headers['content-type']) };
      const hit = findStub(stubs, stubReq);

      if (hit) {
        const out = resolveResponse(hit, stubReq);
        if (out.delay) await sleep(out.delay);
        if (cors) exposeHeaders(res, Object.keys(out.headers));
        res.writeHead(out.status, out.headers);
        res.end(method === 'HEAD' ? undefined : out.bodyText ?? undefined);
        line(out.status, `stub "${hit.stub.name}"`);
        return;
      }

      if (target) {
        const status = await forward(req, res, raw, target, cors);
        line(status, `→ ${target.host}`);
        return;
      }

      sendJson(res, 404, {
        error: `fe-stub: no stub matches ${method} ${url.split('?')[0]}`,
        hint: `Add one in "${dir}/", or start with --target <real-api-url> to forward unmatched calls. See ${ADMIN_PATH} for loaded stubs.`,
      });
      line(404, 'no stub');
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: `fe-stub: ${(err as Error).message}` });
      else res.end();
      line(500, `error: ${(err as Error).message}`);
    }
  };

  // 'localhost' binds both 127.0.0.1 and ::1, so dev-server proxies work whichever one they resolve to.
  const host = options.host ?? 'localhost';
  const hosts = host === 'localhost' ? ['127.0.0.1', '::1'] : [host];
  const servers: http.Server[] = [];
  let port = options.port ?? 3001;
  for (const [i, h] of hosts.entries()) {
    const s = http.createServer(handler);
    try {
      await listen(s, port, h);
    } catch (err) {
      // IPv6 loopback not available on this machine: 127.0.0.1 alone is fine.
      if (i > 0 && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((err as NodeJS.ErrnoException).code ?? '')) continue;
      await Promise.all(servers.map(close));
      throw err;
    }
    port = (s.address() as { port: number }).port; // resolve port 0 once, reuse for ::1
    servers.push(s);
  }

  let watcher: FSWatcher | null = null;
  if (!options.stubs && options.watch !== false && existsSync(resolve(cwd, dir))) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    watcher = watch(resolve(cwd, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          reload();
          log(`↻ reloaded ${stubs.length} stub(s)`);
        } catch (err) {
          log(`✖ stub files have errors, keeping previous stubs:\n${(err as Error).message}`);
        }
      }, 100);
    });
  }

  const displayHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0' ? 'localhost' : host;
  return {
    url: `http://${displayHost}:${port}`,
    port,
    get stubs() { return stubs; },
    reload,
    async close() {
      watcher?.close();
      await Promise.all(servers.map(close));
    },
  };
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  res.setHeader('access-control-allow-origin', origin ?? '*');
  if (origin) {
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('vary', 'Origin');
  }
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS');
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*');
  res.setHeader('access-control-max-age', '600');
}

function exposeHeaders(res: ServerResponse, names: string[]): void {
  if (names.length) res.setHeader('access-control-expose-headers', names.join(', '));
}

/** Forward to the real API. Returns the upstream status. */
function forward(req: IncomingMessage, res: ServerResponse, body: Buffer, target: URL, cors: boolean): Promise<number> {
  return new Promise((done) => {
    const basePath = target.pathname.replace(/\/$/, '');
    const headers = { ...req.headers, host: target.host };
    delete headers.origin; // the real API sees a same-origin server call, not the browser's origin
    const upstream = (target.protocol === 'https:' ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: basePath + (req.url ?? '/'),
      headers,
    }, (up) => {
      const out = { ...up.headers };
      if (cors) {
        // Keep our CORS headers, not the upstream's.
        for (const k of Object.keys(out)) if (k.startsWith('access-control-')) delete out[k];
        out['access-control-expose-headers'] = Object.keys(up.headers).join(', ');
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
      up.on('end', () => done(up.statusCode ?? 502));
    });
    upstream.on('error', (err) => {
      sendJson(res, 502, { error: `fe-stub: could not reach ${target.href}: ${err.message}` });
      done(502);
    });
    upstream.end(body);
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function decodeBody(raw: Buffer, contentType: string | undefined): unknown {
  if (!raw.length) return undefined;
  const text = raw.toString('utf8');
  if (contentType?.includes('application/x-www-form-urlencoded')) return new URLSearchParams(text);
  return text; // JSON is parsed by the matcher
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

function listen(s: http.Server, port: number, host: string): Promise<void> {
  return new Promise((ok, fail) => {
    s.once('error', fail);
    s.listen(port, host, () => { s.off('error', fail); ok(); });
  });
}

function close(s: http.Server): Promise<void> {
  return new Promise((ok) => { s.closeAllConnections?.(); s.close(() => ok()); });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (m: string) => m.padEnd(6);
