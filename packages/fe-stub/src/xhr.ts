// XMLHttpRequest interception. Covers Angular HttpClient (default backend) and axios.
import { findStub, resolveResponse } from './matcher.js';
import type { CompiledStub, ResolvedResponse } from './types.js';
import type { OnHit } from './fetch.js';

interface XhrHost {
  XMLHttpRequest?: typeof XMLHttpRequest;
  location?: { href: string };
}

interface Meta {
  method: string;
  url: string;
  headers: Record<string, string>;
  timer?: ReturnType<typeof setTimeout>;
}

export function patchXhr(host: XhrHost, getStubs: () => CompiledStub[], onHit: OnHit): () => void {
  const Xhr = host.XMLHttpRequest;
  if (!Xhr) return () => {};

  const proto = Xhr.prototype;
  const orig = {
    open: proto.open,
    send: proto.send,
    setRequestHeader: proto.setRequestHeader,
    abort: proto.abort,
  };
  const meta = new WeakMap<XMLHttpRequest, Meta>();

  proto.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    meta.set(this, { method: method.toUpperCase(), url: String(url), headers: {} });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig.open as any).call(this, method, url, ...rest);
  } as typeof proto.open;

  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const m = meta.get(this);
    if (m) m.headers[name] = value;
    return orig.setRequestHeader.call(this, name, value);
  };

  proto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    const req = m && { method: m.method, url: m.url, baseUrl: host.location?.href, headers: m.headers, body };
    const hit = req ? findStub(getStubs(), req) : null;
    if (!req || !hit || !m) return orig.send.call(this, body);

    const res = resolveResponse(hit, req);
    onHit(req, hit, res);
    fire(this, 'loadstart');
    m.timer = setTimeout(() => respond(this, res, req.url, host.location?.href), res.delay);
  };

  proto.abort = function (this: XMLHttpRequest) {
    const m = meta.get(this);
    if (m?.timer !== undefined) {
      clearTimeout(m.timer);
      m.timer = undefined;
      define(this, 'readyState', 4);
      define(this, 'status', 0);
      fire(this, 'readystatechange');
      fire(this, 'abort');
      fire(this, 'loadend');
      return;
    }
    return orig.abort.call(this);
  };

  return () => Object.assign(proto, orig);
}

function respond(xhr: XMLHttpRequest, res: ResolvedResponse, url: string, base?: string): void {
  const text = res.bodyText ?? '';
  const headerLines = Object.entries(res.headers).map(([k, v]) => `${k.toLowerCase()}: ${v}`).join('\r\n');
  const lower = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]));

  define(xhr, 'status', res.status);
  define(xhr, 'statusText', res.statusText);
  define(xhr, 'responseURL', safeUrl(url, base));
  Object.defineProperty(xhr, 'getAllResponseHeaders', { configurable: true, value: () => (headerLines ? `${headerLines}\r\n` : '') });
  Object.defineProperty(xhr, 'getResponseHeader', { configurable: true, value: (n: string) => lower[n.toLowerCase()] ?? null });

  define(xhr, 'readyState', 2);
  fire(xhr, 'readystatechange');

  define(xhr, 'responseText', text);
  define(xhr, 'response', toResponseType(xhr.responseType, res.bodyText));
  define(xhr, 'readyState', 4);
  fire(xhr, 'readystatechange');
  fire(xhr, 'load');
  fire(xhr, 'loadend');
}

function toResponseType(type: XMLHttpRequestResponseType, text: string | null): unknown {
  switch (type) {
    case 'json':
      if (text === null || text === '') return null;
      try { return JSON.parse(text); } catch { return null; }
    case 'blob':
      return new Blob([text ?? '']);
    case 'arraybuffer':
      return new TextEncoder().encode(text ?? '').buffer;
    default:
      return text ?? '';
  }
}

function define(xhr: XMLHttpRequest, key: string, value: unknown): void {
  Object.defineProperty(xhr, key, { configurable: true, get: () => value });
}

function fire(xhr: XMLHttpRequest, type: string): void {
  const ev = typeof ProgressEvent !== 'undefined' ? new ProgressEvent(type) : new Event(type);
  xhr.dispatchEvent(ev);
}

function safeUrl(url: string, base?: string): string {
  try { return new URL(url, base).href; } catch { return url; }
}
