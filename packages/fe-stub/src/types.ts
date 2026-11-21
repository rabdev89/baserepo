export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*';

export interface StubResponse {
  /** HTTP status code. Default 200. */
  status?: number;
  /** Response headers. `content-type: application/json` is added for object bodies. */
  headers?: Record<string, string>;
  /** Response body. Strings support {{params.x}}, {{query.x}}, {{body.x}} placeholders. */
  body?: unknown;
  /** Path to a JSON file (relative to the stub file). Inlined by the CLI at build time. */
  bodyFile?: string;
  /** Artificial latency in ms. Default 0. */
  delay?: number;
}

export interface StubMatch {
  /** Every listed query param must equal the given value. */
  query?: Record<string, string | number | boolean>;
  /** Every listed header must equal the given value (case-insensitive name). */
  headers?: Record<string, string>;
  /** Partial deep match against the JSON request body. */
  body?: unknown;
}

export interface Stub {
  name?: string;
  /** Default 'GET'. Use '*' for any method. */
  method?: HttpMethod | Lowercase<HttpMethod>;
  /** "/api/users/:id", "/api/*", or an absolute URL "https://api.example.com/users". */
  endpoint: string;
  /** Default true. Set false to keep a stub on file but skip it. */
  enabled?: boolean;
  match?: StubMatch;
  response: StubResponse;
}

/** The JSON file the CLI writes and the runtime loads. */
export interface StubBundle {
  enabled: boolean;
  generatedAt?: string;
  stubs: Stub[];
}

export interface CompiledStub extends Omit<Stub, 'method' | 'response' | 'name' | 'enabled'> {
  name: string;
  method: string;
  enabled: boolean;
  response: Required<Pick<StubResponse, 'status' | 'headers' | 'delay'>> & StubResponse;
  _origin: string | null;
  _regex: RegExp;
  _keys: string[];
}

export interface StubRequest {
  method?: string;
  url: string;
  baseUrl?: string;
  headers?: Headers | Record<string, string> | null;
  body?: unknown;
}

export interface StubHit {
  stub: CompiledStub;
  params: Record<string, string>;
}

export interface ResolvedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Already-serialised body text, or null for empty bodies. */
  bodyText: string | null;
  delay: number;
}

export interface SetupOptions {
  /** URL of the bundle the CLI writes. Default '/__stubs__.json'. Ignored if `stubs` is given. */
  url?: string;
  /** Pass stubs inline instead of loading a bundle. */
  stubs?: Stub[];
  /**
   * Force on/off. When omitted, the bundle's `enabled` flag decides
   * (true while `fe-stub run` is active). A `?stub=on|off` URL toggle overrides both.
   */
  enabled?: boolean;
  /** Hostnames where stubbing is allowed. Stubs never run anywhere else. */
  allowedHosts?: string[];
  /** Log every stubbed call to the console. Default true. */
  log?: boolean;
  /** Show a small "STUB" badge in the corner. Default true. */
  badge?: boolean;
  /** Patch window.fetch. Default true. */
  fetch?: boolean;
  /** Patch XMLHttpRequest (Angular HttpClient, axios). Default true. */
  xhr?: boolean;
}

export interface StubController {
  /** True if interception is active. */
  readonly active: boolean;
  /** Loaded stubs. */
  readonly stubs: CompiledStub[];
  /** Restore the original fetch / XMLHttpRequest. */
  uninstall(): void;
}
