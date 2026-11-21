# fe-stub

Stub HTTP calls in **any frontend** (React, Angular, Vue, Svelte, plain JS) from JSON files, **only on your local machine**.

- Run `npm run start:stub` → matching calls get the stub response.
- Run `npm start` → everything goes to the real API, as usual.
- Works with `fetch`, Angular `HttpClient`, axios, and anything built on `XMLHttpRequest`.
- Never activates outside `localhost` / `127.0.0.1`, even if the file ships by mistake.
- Written in TypeScript, zero runtime dependencies.

---

## How it works

```
stubs/*.json ──(fe-stub run)──▶ public/__stubs__.json { enabled: true, stubs: [...] }
                                         │
browser: setupStub() ── loads it ────────┘ ── patches fetch + XHR
         request matches a stub?  yes → stub response     no → real network
```

1. `fe-stub run -- <dev command>` merges your stub files into one bundle with `enabled: true`, watches for edits, and starts your dev server.
2. `setupStub()` in your app loads that bundle and intercepts matching requests.
3. When you stop the command, the bundle is flipped back to `enabled: false`.

---

## Install

```bash
npm i -D fe-stub
npx fe-stub init        # creates stubs/, fe-stub.config.json, gitignores the bundle
```

Add one script to `package.json`:

```json
{
  "scripts": {
    "start": "ng serve",
    "start:stub": "fe-stub run -- ng serve"
  }
}
```

Use your own dev command: `vite`, `react-scripts start`, `next dev`, `vue-cli-service serve`, etc.

---

## Wire it into your app

Call `setupStub()` **before** the app starts making requests.

### React (Vite)

```tsx
// src/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

async function start() {
  if (import.meta.env.DEV) {
    const { setupStub } = await import('fe-stub');
    await setupStub();
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
}

start();
```

### React (Create React App / webpack)

Same as above, but use `if (process.env.NODE_ENV === 'development')`.

### Angular (17+)

```ts
// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { isDevMode } from '@angular/core';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

async function start() {
  if (isDevMode()) {
    const { setupStub } = await import('fe-stub');
    await setupStub();
  }
  await bootstrapApplication(AppComponent, appConfig);
}

start().catch((err) => console.error(err));
```

Angular serves `public/` by default (v18+). On older projects that use `src/assets`, set the output and URL:

```json
// fe-stub.config.json
{ "dir": "stubs", "out": "src/assets/__stubs__.json" }
```

```ts
await setupStub({ url: '/assets/__stubs__.json' });
```

For `NgModule` apps, wrap `platformBrowserDynamic().bootstrapModule(AppModule)` the same way.

### Vue / Svelte / anything else

Same pattern: `await setupStub()` before `createApp(...).mount(...)`.

> Using a dynamic `import()` behind a dev check keeps fe-stub out of your production bundle entirely.

---

## Stub file format

Put any number of `.json` files in `stubs/`. Each file can be one stub, an array of stubs, or `{ "stubs": [...] }`.

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
| `endpoint` | ✔ | `/api/users`, `/api/users/:id`, `/api/files/*`, or a full URL `https://api.x.com/v1/ping` |
| `method` | | `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, or `*` for any |
| `response.status` | | Default `200` |
| `response.body` | | Any JSON. Objects are sent as `application/json` |
| `response.bodyFile` | | Load the body from a JSON file (relative to the stub file) |
| `response.headers` | | Extra response headers |
| `response.delay` | | Fake latency in ms |
| `match.body` | | Partial match on the JSON request body |
| `match.query` | | Exact match on query params |
| `match.headers` | | Exact match on request headers |
| `enabled` | | `false` keeps the stub on file but skips it |
| `name` | | Shown in logs and `fe-stub list` |

**Rules**

- **First match wins.** Put specific stubs (with `match`) before generic ones. `fe-stub validate` warns when one hides another.
- Relative endpoints match **any host**, so `/api/orders` also catches `http://localhost:8080/api/orders` (handy when your `environment.apiUrl` points at a local backend).
- Unmatched requests go to the real network untouched.

**Templates** in `response.body`: `{{params.id}}`, `{{query.page}}`, `{{body.email}}`. A string that is only a placeholder keeps its type (`"{{body.qty}}"` → `2`, not `"2"`).

**Editor autocomplete:** add `"$schema": "../node_modules/fe-stub/schema.json"` (object form), or in VS Code `settings.json`:

```json
"json.schemas": [{ "fileMatch": ["stubs/*.json"], "url": "./node_modules/fe-stub/schema.json" }]
```

---

## Turning it on and off

| How | Effect |
|---|---|
| `npm run start:stub` | On while the command runs |
| `npm start` | Off |
| `?stub=off` in the browser URL | Off, remembered in localStorage |
| `?stub=on` | On, even with plain `npm start` (needs the bundle file to exist: run `fe-stub build` once) |
| `?stub=reset` | Forget the override |
| Click the purple **STUB** badge | Turn off and reload |
| Not on localhost | Always off. Cannot be overridden |

Every stubbed call is logged to the console:
`[fe-stub] POST /api/orders → 201 (Create order)`

---

## CLI

```
fe-stub init                      Create stubs/ with examples and fe-stub.config.json
fe-stub run [opts] -- <command>   Bundle with stubs ON, watch for changes, run <command>
fe-stub build [opts] [--enabled]  Write the bundle once (OFF unless --enabled)
fe-stub validate [opts]           Check stub files; exit 1 on errors (good for CI)
fe-stub list [opts]               Table of stubbed endpoints

--dir <path>   Stub folder         (default: stubs)
--out <path>   Bundle output file  (default: public/__stubs__.json)
```

Edits to stub files are picked up on the next request. No restart needed.

---

## `setupStub(options)`

```ts
import { setupStub, defineStubs } from 'fe-stub';

const stub = await setupStub({
  url: '/__stubs__.json',      // where the bundle is served
  stubs: defineStubs([...]),   // or pass stubs inline (skips the bundle)
  enabled: undefined,          // force true/false; default: bundle decides
  allowedHosts: ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'], // + *.localhost
  log: true,                   // console log per stubbed call
  badge: true,                 // corner badge
  fetch: true,                 // patch window.fetch
  xhr: true,                   // patch XMLHttpRequest
});

stub.active;      // boolean
stub.stubs;       // loaded stubs
stub.uninstall(); // restore fetch / XHR
```

Also available in the console as `window.__feStub`.

---

## Development

```bash
npm install
npm run build   # tsc → dist/
npm test        # 18 tests: matcher, fetch, XHR, setup, CLI
```
