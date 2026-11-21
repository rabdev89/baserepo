export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | '*';

export interface StubResponse {
  /** HTTP status code. Default 200. */
  status?: number;
  /** Response headers. `content-type` is added automatically for JSON / text bodies. */
  headers?: Record<string, string>;
  /** Response body. Strings support {{params.x}}, {{query.x}}, {{body.x}} placeholders. */
  body?: unknown;
  /** Path to a JSON (or text) file, relative to the stub file. */
  bodyFile?: string;
  /** Artificial latency in ms. Default 0. */
  delay?: number;
}

export interface StubMatch {
  /** Every listed query param must equal the given value. */
  query?: Record<string, string | number | boolean>;
  /** Every listed header must equal the given value (case-insensitive name). */
  headers?: Record<string, string>;
  /** Partial deep match against the JSON / form request body. */
  body?: unknown;
}

export interface Stub {
  name?: string;
  /** Default 'GET'. Use '*' for any method. */
  method?: HttpMethod | Lowercase<HttpMethod>;
  /** Request path: "/api/users", "/api/users/:id", "/api/files/*". */
  endpoint: string;
  /** Default true. Set false to keep a stub on file but skip it. */
  enabled?: boolean;
  match?: StubMatch;
  response: StubResponse;
}

export interface CompiledStub extends Omit<Stub, 'method' | 'response' | 'name' | 'enabled'> {
  name: string;
  method: string;
  enabled: boolean;
  response: Required<Pick<StubResponse, 'status' | 'headers' | 'delay'>> & StubResponse;
  _regex: RegExp;
  _keys: string[];
}

export interface StubRequest {
  method?: string;
  /** Path with optional query string, e.g. "/api/users?page=2". */
  url: string;
  headers?: Record<string, string | string[] | undefined> | null;
  body?: unknown;
}

export interface StubHit {
  stub: CompiledStub;
  params: Record<string, string>;
}

export interface ResolvedResponse {
  status: number;
  headers: Record<string, string>;
  /** Serialised body, or null for an empty body. */
  bodyText: string | null;
  delay: number;
}

export interface ServerOptions {
  /** Folder with stub JSON files. Default 'stubs'. Ignored if `stubs` is given. */
  dir?: string;
  /** Inline stubs instead of a folder. */
  stubs?: Stub[];
  /** Port to listen on. Default 3001. Use 0 for a random free port. */
  port?: number;
  /**
   * Interface to bind. Default 'localhost' = 127.0.0.1 and ::1 only,
   * so the stub API is reachable from this machine and nowhere else.
   */
  host?: string;
  /** Real backend. Requests with no matching stub are forwarded here. Otherwise they get 404. */
  target?: string;
  /** Reload stubs when files in `dir` change. Default true. */
  watch?: boolean;
  /** Add CORS headers so the browser can call the stub API directly. Default true. */
  cors?: boolean;
  /** Log each request. `false` to silence, or a function to receive lines. Default console.log. */
  log?: boolean | ((line: string) => void);
  /** Base folder for relative paths. Default process.cwd(). */
  cwd?: string;
}

export interface StubServer {
  /** e.g. "http://localhost:3001" */
  readonly url: string;
  readonly port: number;
  /** Currently loaded stubs. */
  readonly stubs: CompiledStub[];
  /** Re-read the stub folder. Throws if the files are invalid (previous stubs stay active). */
  reload(): void;
  close(): Promise<void>;
}
