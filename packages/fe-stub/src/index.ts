import { compileStubs } from './matcher.js';
import { patchFetch, type OnHit } from './fetch.js';
import { patchXhr } from './xhr.js';
import type { CompiledStub, SetupOptions, Stub, StubBundle, StubController } from './types.js';

export * from './types.js';
export { compileStubs, findStub, resolveResponse } from './matcher.js';
export { patchFetch } from './fetch.js';
export { patchXhr } from './xhr.js';

export const DEFAULT_BUNDLE_URL = '/__stubs__.json';
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];
const STORAGE_KEY = 'fe-stub';
const TAG = '%c[fe-stub]';
const TAG_STYLE = 'color:#fff;background:#7c3aed;padding:1px 4px;border-radius:3px';

/** Typed helper for inline stubs. */
export function defineStubs(stubs: Stub[]): Stub[] {
  return stubs;
}

/**
 * Call once before your app bootstraps.
 * Does nothing (and makes no network call) unless the page runs on a local host.
 */
export async function setupStub(options: SetupOptions = {}): Promise<StubController> {
  const inactive: StubController = { active: false, stubs: [], uninstall() {} };
  if (typeof window === 'undefined' || !window.location) return inactive; // SSR / tests

  const allowed = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  const host = window.location.hostname;
  if (!allowed.includes(host) && !host.endsWith('.localhost')) return inactive;

  const toggle = readToggle();
  if (toggle === 'off') return inactive;
  if (options.enabled === false && toggle !== 'on') return inactive;

  let raw: Stub[];
  if (options.stubs) {
    raw = options.stubs;
  } else {
    const bundle = await loadBundle(options.url ?? DEFAULT_BUNDLE_URL);
    if (!bundle) return inactive;
    const forced = options.enabled === true || toggle === 'on';
    if (!bundle.enabled && !forced) return inactive;
    raw = bundle.stubs;
  }

  let stubs: CompiledStub[];
  try {
    stubs = compileStubs(raw);
  } catch (err) {
    console.error(err);
    return inactive;
  }

  const log = options.log !== false;
  const onHit: OnHit = (req, hit, res) => {
    if (log) console.info(TAG, TAG_STYLE, `${req.method} ${req.url} → ${res.status} (${hit.stub.name})`);
  };
  const get = () => stubs;
  const undo: Array<() => void> = [];
  if (options.fetch !== false && typeof window.fetch === 'function') undo.push(patchFetch(window, get, onHit));
  if (options.xhr !== false) undo.push(patchXhr(window, get, onHit));

  const removeBadge = options.badge === false ? () => {} : showBadge(stubs.filter((s) => s.enabled).length);
  if (log) console.info(TAG, TAG_STYLE, `stubbing ${stubs.length} endpoint(s). Disable with ?stub=off`);

  const controller: StubController = {
    active: true,
    stubs,
    uninstall() {
      undo.forEach((fn) => fn());
      removeBadge();
      (controller as { active: boolean }).active = false;
    },
  };
  (window as unknown as { __feStub?: StubController }).__feStub = controller;
  return controller;
}

/** `?stub=on|off` wins and is remembered in localStorage until changed. */
function readToggle(): 'on' | 'off' | null {
  let value: string | null = null;
  try {
    value = new URLSearchParams(window.location.search).get('stub');
  } catch { /* ignore */ }
  try {
    if (value === 'on' || value === 'off') {
      window.localStorage.setItem(STORAGE_KEY, value);
      return value;
    }
    if (value === 'reset') {
      window.localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'on' || stored === 'off' ? stored : null;
  } catch {
    return value === 'on' || value === 'off' ? value : null;
  }
}

async function loadBundle(url: string): Promise<StubBundle | null> {
  try {
    const res = await window.fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) return null; // SPA fallback served index.html
    const data = (await res.json()) as StubBundle | Stub[];
    return Array.isArray(data) ? { enabled: true, stubs: data } : data;
  } catch {
    return null;
  }
}

function showBadge(count: number): () => void {
  if (typeof document === 'undefined') return () => {};
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = `STUB · ${count}`;
  el.title = 'fe-stub is intercepting API calls. Click to turn off (reloads the page).';
  el.setAttribute('style', [
    'position:fixed', 'left:8px', 'bottom:8px', 'z-index:2147483647',
    'font:600 11px/1 system-ui,sans-serif', 'letter-spacing:.04em',
    'padding:6px 8px', 'border:0', 'border-radius:6px', 'cursor:pointer',
    'color:#fff', 'background:#7c3aed', 'box-shadow:0 2px 6px rgba(0,0,0,.25)', 'opacity:.85',
  ].join(';'));
  el.addEventListener('click', () => {
    try { window.localStorage.setItem(STORAGE_KEY, 'off'); } catch { /* ignore */ }
    window.location.reload();
  });
  const mount = () => document.body?.appendChild(el);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  return () => el.remove();
}
