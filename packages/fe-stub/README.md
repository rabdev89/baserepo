# fe-stub

**A local stub API for any frontend** (React, Angular, Vue, Svelte, ...). It runs on its own port, like a real backend, and answers from JSON files.

- `npm run start:stub` starts the stub API (port 3001) and your dev server together.
- `npm start` works as before, against your real API.
- No code in your app. Your app makes real HTTP calls; they just land on the stub server.
- Optional `--target`: stub a few endpoints, forward everything else to the real backend.
- Only reachable from your own machine (binds to `localhost`).
- Written in TypeScript, zero runtime dependencies.

---

## How it works

```
browser ──▶ dev server :4200 ──/api proxy──▶ fe-stub :3001 ──┬─ stub matches? → JSON from stubs/*.json
                                                            └─ no match      → --target (real API) or 404
```

---

## Install

```bash
npm i -D fe-stub
npx fe-stub init
```

`init` creates `stubs/` with examples and `fe-stub.config.json`. In an Angular project it also creates `proxy.stub.json`.

Then add one script, based on your framework.

### Angular

```json
"start":      "ng serve",
"start:stub": "fe-stub run -- ng serve --proxy-config proxy.stub.json"
```

```json
// proxy.stub.json
{ "/api": { "target": "http://localhost:3001", "secure": false } }
```

Your services keep calling `/api/...`. Nothing else changes.

> If your `environment.apiUrl` is an absolute URL (e.g. `https://api.example.com`), either switch dev to a relative `/api` with the proxy, or add an `environment.stub.ts` with `apiUrl: 'http://localhost:3001'` and run `ng serve --configuration stub`. CORS is already handled.

### React + Vite

```json
"dev":      "vite",
"dev:stub": "fe-stub run -- vite"
```

```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: process.env.FE_STUB_URL
      ? { '/api': { target: process.env.FE_STUB_URL, changeOrigin: true } }
      : undefined,
  },
});
```

### React (Create React App) or any app with an API URL env var

```json
"start:stub": "fe-stub run --env REACT_APP_API_URL -- react-scripts start"
```

`--env NAME` sets that variable to `http://localhost:3001` for the dev command. Use `VITE_API_URL`, `NEXT_PUBLIC_API_URL`, etc. the same way.

### Just the server

```bash
npx fe-stub serve --port 3001
```

Point anything at `http://localhost:3001`: your app, Postman, curl, Playwright tests.

---

## Stub files

Put any number of `.json` files in `stubs/`. Each file is one stub, an array of stubs, or `{ "stubs": [...] }`.

```json
{
  "$schema": "../node_modules/fe-stub/schema.json",
  "stubs": [
    {
      "name": "Create order - out of stock",
      "method": "POST",
      "endpoint": "/api/orders",
      "match": { "body": { "sku": "SOLD-OUT" } },
      "response": { "status": 409, "body": { "message": "Out of stock" } }
    },
    {
      "name": "Create order",
      "method": "POST",
      "endpoint": "/api/orders",
      "response": {
        "status": 201,
        "delay": 400,
        "headers": { "x-request-id": "stub" },
        "body": { "id": "ord_123", "sku": "{{body.sku}}", "qty": "{{body.qty}}" }
      }
    },
    {
      "name": "Get order",
      "endpoint": "/api/orders/:id",
      "response": { "bodyFile": "responses/order.json" }
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `endpoint` | ✔ | `/api/users`, `/api/users/:id`, `/api/files/*` |
| `method` | | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, or `*` for any |
| `response.status` | | Default `200` |
| `response.body` | | Any JSON. Objects are sent as `application/json` |
| `response.bodyFile` | | Load the body from a file, relative to the stub file |
| `response.headers` | | Extra response headers |
| `response.delay` | | Fake latency in ms |
| `match.body` | | Partial match on the JSON or form request body |
| `match.query` | | Exact match on query params |
| `match.headers` | | Exact match on request headers |
| `enabled` | | `false` keeps the stub on file but skips it |
| `name` | | Shown in logs and `fe-stub list` |

**Rules**

- **First match wins.** Files load in alphabetical order. Put specific stubs (with `match`) before generic ones. `fe-stub validate` warns when one hides another.
- **Templates** in the body: `{{params.id}}`, `{{query.page}}`, `{{body.email}}`. A string that is only a placeholder keeps its type (`"{{body.qty}}"` → `2`, not `"2"`).
- **Edits reload instantly.** Save a stub file and the next request uses it. If the file is broken, the previous stubs stay active and the error is logged.

**Editor autocomplete:** use `"$schema"` as above, or in VS Code `settings.json`:

```json
"json.schemas": [{ "fileMatch": ["stubs/*.json"], "url": "./node_modules/fe-stub/schema.json" }]
```

---

## Behaves like a real API

- **CORS** is on, so a browser can call `http://localhost:3001` directly. Preflights, credentials and custom response headers all work.
- **Unmatched requests:** forwarded to `--target` if set, otherwise `404` with a JSON message naming the missing route.
- **Logs** every request:
  ```
  [fe-stub] POST   /api/auth/login → 200 stub "Login OK" (302ms)
  [fe-stub] GET    /api/orders → 200 → api.example.com (85ms)
  [fe-stub] GET    /api/nope → 404 no stub (0ms)
  ```
- **`GET /__fe-stub`** lists the loaded stubs.

---

## CLI

```
fe-stub serve [opts]                  Start the stub API
fe-stub run [opts] -- <dev command>   Start the stub API, then your dev server (stops together)
fe-stub init                          Create stubs/ and fe-stub.config.json (+ proxy.stub.json for Angular)
fe-stub validate [opts]               Check stub files; exit 1 on errors (good for CI)
fe-stub list [opts]                   Table of stubbed endpoints

--port <n>       Stub API port                      (default 3001)
--dir <path>     Stub folder                        (default stubs)
--target <url>   Forward unmatched calls here       (default: none → 404)
--host <host>    Interface to bind                  (default localhost = this machine only)
--env <NAME>     run only: set NAME=<stub API URL> for the dev command (repeatable)
```

`run` always sets `FE_STUB=true`, `FE_STUB_URL` and `FE_STUB_PORT` for the dev command.

All options can live in `fe-stub.config.json`:

```json
{ "dir": "stubs", "port": 3001, "target": "https://dev-api.example.com" }
```

---

## Programmatic use (e.g. in Playwright / Cypress setup)

```ts
import { startStubServer, defineStubs } from 'fe-stub';

const api = await startStubServer({
  port: 0,                       // random free port
  stubs: defineStubs([{ method: 'POST', endpoint: '/api/login', response: { status: 401 } }]),
  log: false,
});
console.log(api.url);            // http://localhost:54321
await api.close();
```

---

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # matcher, server (real HTTP), CLI
```
