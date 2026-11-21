import type { Stub } from './types.js';

export * from './types.js';
export { startStubServer, ADMIN_PATH } from './server.js';
export { collectStubs, findShadowed, loadConfig, DEFAULT_CONFIG, CONFIG_FILE } from './loader.js';
export { compileStubs, findStub, resolveResponse } from './matcher.js';

/** Typed helper for inline stubs. */
export function defineStubs(stubs: Stub[]): Stub[] {
  return stubs;
}
