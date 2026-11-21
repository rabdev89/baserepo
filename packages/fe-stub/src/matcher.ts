// Pure matching helpers. No browser globals, so they run in Node tests too.
import type {
  CompiledStub, ResolvedResponse, Stub, StubHit, StubRequest,
} from './types.js';

const BASE = 'http://fe-stub.local';

/** Validate a stub and pre-compile its endpoint pattern. */
export function compileStub(stub: Stub, index = 0): CompiledStub {
  if (!stub || typeof stub !== 'object') {
    throw new Error(`[fe-stub] stub #${index} is not an object`);
  }
  if (!stub.endpoint || typeof stub.endpoint !== 'string') {
    throw new Error(`[fe-stub] stub #${index} ("${stub.name ?? 'unnamed'}") is missing "endpoint"`);
  }
  if (!stub.response || typeof stub.response !== 'object') {
    throw new Error(`[fe-stub] stub "${stub.name ?? stub.endpoint}" is missing "response"`);
  }
  const method = (stub.method ?? 'GET').toUpperCase();
  const { regex, keys } = pathToRegex(toPath(stub.endpoint));
  return {
    ...stub,
    name: stub.name ?? `${method} ${stub.endpoint}`,
    method,
    enabled: stub.enabled !== false,
    response: { status: 200, headers: {}, delay: 0, ...stub.response },
    _regex: regex,
    _keys: keys,
  };
}

export function compileStubs(stubs: Stub[]): CompiledStub[] {
  return stubs.map((s, i) => compileStub(s, i));
}

/** First enabled stub matching the request, or null. */
export function findStub(stubs: CompiledStub[], req: StubRequest): StubHit | null {
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url, BASE);
  } catch {
    return null;
  }

  for (const stub of stubs) {
    if (!stub.enabled) continue;
    if (stub.method !== '*' && stub.method !== method) continue;

    const m = stub._regex.exec(url.pathname);
    if (!m) continue;

    const params: Record<string, string> = {};
    stub._keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] ?? ''); });

    if (stub.match?.query && !matchQuery(stub.match.query, url.searchParams)) continue;
    if (stub.match?.headers && !matchHeaders(stub.match.headers, req.headers)) continue;
    if (stub.match?.body !== undefined && !partialMatch(stub.match.body, parseBody(req.body))) continue;

    return { stub, params };
  }
  return null;
}

/** Build the final response (templating + serialisation) for a hit. */
export function resolveResponse(hit: StubHit, req: StubRequest): ResolvedResponse {
  const url = new URL(req.url, BASE);
  const ctx = {
    params: hit.params,
    query: Object.fromEntries(url.searchParams.entries()),
    body: parseBody(req.body),
  };
  const { status, headers, delay, body } = hit.stub.response;
  const rendered = renderTemplate(body, ctx);
  const outHeaders: Record<string, string> = { ...headers };
  const hasType = Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-type');

  let bodyText: string | null;
  if (rendered === undefined || rendered === null || status === 204 || status === 304) {
    bodyText = null;
  } else if (typeof rendered === 'string') {
    bodyText = rendered;
    if (!hasType) outHeaders['content-type'] = 'text/plain';
  } else {
    bodyText = JSON.stringify(rendered);
    if (!hasType) outHeaders['content-type'] = 'application/json';
  }

  return {
    status,
    headers: outHeaders,
    bodyText,
    delay,
  };
}

/** "/api/users/:id/*" -> RegExp. Trailing slash is optional. */
export function pathToRegex(path: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const pattern = trimmed
    .split('/')
    .map((seg) => {
      if (seg === '*' || seg === '**') return '.*';
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    })
    .join('/');
  return { regex: new RegExp(`^${pattern}/?$`), keys };
}

/** Accepts "/api/x", "api/x" or a full URL (only its path is used). */
function toPath(endpoint: string): string {
  let path = endpoint.split('?')[0].replace(/^https?:\/\/[^/]+/i, '');
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

function matchQuery(expected: Record<string, unknown>, sp: URLSearchParams): boolean {
  return Object.entries(expected).every(([k, v]) => sp.get(k) === String(v));
}

function matchHeaders(expected: Record<string, string>, headers: StubRequest['headers']): boolean {
  const get = (name: string): string | null => {
    if (!headers) return null;
    const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
    const v = key ? headers[key] : undefined;
    return Array.isArray(v) ? v.join(', ') : v ?? null;
  };
  return Object.entries(expected).every(([k, v]) => get(k) === String(v));
}

export function parseBody(body: unknown): unknown {
  if (body == null) return body;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return body; }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  return body;
}

/** Every key in `expected` must exist (deeply) in `actual`. Extra keys in `actual` are fine. */
export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.length === actual.length
      && expected.every((v, i) => partialMatch(v, actual[i]));
  }
  return Object.entries(expected as Record<string, unknown>)
    .every(([k, v]) => partialMatch(v, (actual as Record<string, unknown>)[k]));
}

/** Replace {{params.id}}, {{query.page}}, {{body.email}} inside the response body. */
export function renderTemplate(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) {
      const v = lookup(ctx, whole[1]);
      return v === undefined ? value : v; // keep type (number, object) for whole-value placeholders
    }
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (raw, p: string) => {
      const v = lookup(ctx, p);
      return v === undefined ? raw : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderTemplate(v, ctx)]),
    );
  }
  return value;
}

function lookup(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    obj,
  );
}
