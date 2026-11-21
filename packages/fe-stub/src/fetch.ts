import { findStub, resolveResponse } from './matcher.js';
import type { CompiledStub, ResolvedResponse, StubHit, StubRequest } from './types.js';

export type OnHit = (req: StubRequest, hit: StubHit, res: ResolvedResponse) => void;

interface FetchHost {
  fetch: typeof fetch;
  location?: { href: string };
}

/** Wrap `host.fetch`. Unmatched requests go to the real fetch. Returns an uninstall function. */
export function patchFetch(host: FetchHost, getStubs: () => CompiledStub[], onHit: OnHit): () => void {
  const original = host.fetch;

  const stubbedFetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const req = await toStubRequest(input, init, host.location?.href);
    const hit = findStub(getStubs(), req);
    if (!hit) return original.call(host, input, init);

    const res = resolveResponse(hit, req);
    onHit(req, hit, res);
    await sleep(res.delay, init?.signal ?? (input instanceof Request ? input.signal : undefined));
    return new Response(res.bodyText, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  host.fetch = stubbedFetch as typeof fetch;
  return () => { if (host.fetch === stubbedFetch) host.fetch = original; };
}

async function toStubRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  baseUrl: string | undefined,
): Promise<StubRequest> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const method = (init?.method ?? input.method).toUpperCase();
    let body: unknown = init?.body;
    if (body === undefined && method !== 'GET' && method !== 'HEAD') {
      try { body = await input.clone().text(); } catch { body = undefined; }
    }
    return { method, url: input.url, baseUrl, headers: init?.headers ? new Headers(init.headers) : input.headers, body };
  }
  return {
    method: (init?.method ?? 'GET').toUpperCase(),
    url: String(input),
    baseUrl,
    headers: init?.headers ? new Headers(init.headers) : null,
    body: init?.body,
  };
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

function abortError(): Error {
  return typeof DOMException !== 'undefined'
    ? new DOMException('The operation was aborted.', 'AbortError')
    : Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}
