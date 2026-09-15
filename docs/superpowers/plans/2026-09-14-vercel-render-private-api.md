# Vercel 可信入口与 Render 私有 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Vercel Authentication and a same-origin server-side proxy the only browser path to WarmBuddy, require a hidden shared secret at every Render `/api/*` route, and prevent configuration reads or logs from exposing complete third-party credentials.

**Architecture:** Browser code calls same-origin `/api/*`; a Vercel Node Function forwards to one fixed Render origin and injects `RENDER_PROXY_SECRET`. Render rejects every unauthenticated `/api/*` request before body parsing, while a focused security module owns secret comparison, internal self-calls, and response sanitization. Existing user-entered LLM API keys and MCP tokens remain in the current client/write flow, but read responses and logs become non-secret.

**Tech Stack:** Node.js 22, CommonJS, Express 5, Vercel Node Functions, native `fetch`, Node streams, vanilla browser JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-14-vercel-render-private-api-design.md`

## Global Constraints

- Vercel Authentication with All Deployments enabled is the only browser identity boundary.
- `RENDER_PROXY_SECRET` must contain at least 32 random bytes and exist only in Vercel and Render server-side environment variables.
- Never expose `RENDER_PROXY_SECRET` through `public/`, client responses, browser storage, source maps, logs, errors, or documentation values.
- Existing user-entered third-party LLM API keys and MCP tokens remain in the current client configuration and write flow.
- Read APIs return only non-secret fields and configured-state booleans; they never return a complete API key or token.
- Server logs never contain complete or partial credentials, credential hashes or lengths, sensitive request bodies, or raw upstream bodies.
- Do not add rate limiting, per-user authorization, a credential vault, database migrations, Supabase RLS changes, or automatic credential rotation.
- Preserve chat/SSE behavior, existing business route shapes where not explicitly changed, and current-device local credentials.
- Render `/healthz` is the only new anonymous status route; all `/api` and `/api/*` routes fail closed.
- Every implementation task follows red-green-refactor and ends with focused tests plus an independently reviewable commit.

## Mandatory Execution Order

The numbered sections separate reviewable engineering units, but the production bridge is a hard release gate. Execute in this order:

```text
Tasks 1 → 2 → 3
  → Task 7 Steps 1-5 (document and deploy the Vercel bridge; move cron)
  → Tasks 4 → 5 → 6
  → Task 7 Step 6 (commit the completed runbook record)
  → Task 8 (deploy Render lockdown and run production acceptance)
```

Do not deploy Task 4's Render guard before Task 7 Steps 1-5 pass. If the repository branch triggers automatic Render deployments, pause Render Auto-Deploy or keep Tasks 4-6 off that tracked branch until the bridge gate is complete. Never add a temporary anonymous bypass flag to compensate for deployment ordering.

## File Structure

- Create `render-api-security.js`: Render API guard, constant-time comparison, client response sanitizers, sensitive URL cleanup, and authenticated localhost fetch factory.
- Create `vercel-render-proxy.js`: framework-independent Vercel-to-Render proxy factory with fixed-origin routing, header policy, body limit, streaming, and stable errors.
- Create `api/[...path].js`: minimal Vercel Function entrypoint that instantiates and exports the proxy.
- Modify `server.js`: middleware order, health endpoint, Render redirect, sanitized responses, internal calls, CORS removal, and safe logging.
- Modify `claude-code-gateway.js`: remove credential hash/length diagnostics while retaining boolean configuration telemetry.
- Modify `public/js/app-core.js`: use same-origin API in deployed browsers.
- Modify `public/js/memory.js`: remove the direct Render fallback.
- Modify `public/js/toolkit.js`: merge sanitized server metadata without replacing a local MCP token.
- Review `vercel.json`: keep the existing static `outputDirectory` declaration; no content change is expected because Vercel discovers the root `api/` Function independently.
- Modify `.env.example`: document variable names and non-secret example origins without credential values.
- Create `test/render-api-security.test.js`: guard, sanitizer, sensitive URL, and internal fetch unit tests.
- Create `test/vercel-render-proxy.test.js`: proxy routing, header, failure, size, and streaming tests.
- Create `test/frontend-private-api.test.js`: static frontend invariants and local-token merge behavior.
- Modify `test/claude-code-gateway.test.js`: replace tests for credential diagnostics with no-secret logging assertions.
- Create `docs/vercel-render-private-api-runbook.md`: exact Vercel, Render, cron-job.org, verification, rotation, and rollback procedure without secret values.

---

### Task 1: Add the Render security seam

**Files:**
- Create: `render-api-security.js`
- Create: `test/render-api-security.test.js`

**Interfaces:**
- Produces `RENDER_PROXY_HEADER = 'x-warmbuddy-proxy-secret'`.
- Produces `createRenderApiGuard({ secret, headerName = RENDER_PROXY_HEADER }) -> (req, res, next) => void`.
- Produces `sanitizeProjectConfigForClient(config) -> object|null`.
- Produces `sanitizeToolDefinitionForClient(definition) -> object`.
- Produces `sanitizeToolDefinitionsForClient(definitions) -> object[]`.
- Produces `createInternalApiFetch({ origin, secret, fetchImpl = fetch }) -> async function internalApiFetch(path, init) -> Response`.

- [ ] **Step 1: Write failing tests for the API guard**

Add tests using minimal request/response stubs. Cover correct, absent, and incorrect credentials without putting the supplied value in logs or responses:

```js
test('Render API guard rejects absent and wrong secrets with the same response', () => {
  const guard = createRenderApiGuard({ secret: 'server-secret-at-least-32-bytes-long' });
  for (const supplied of [undefined, 'wrong-secret']) {
    const result = invokeGuard(guard, supplied);
    assert.equal(result.nextCalled, false);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, {
      error: 'Unauthorized',
      code: 'RENDER_API_UNAUTHORIZED'
    });
    assert.doesNotMatch(JSON.stringify(result), /wrong-secret|server-secret/);
  }
});

test('Render API guard accepts the exact proxy secret', () => {
  const guard = createRenderApiGuard({ secret: 'server-secret-at-least-32-bytes-long' });
  const result = invokeGuard(guard, 'server-secret-at-least-32-bytes-long');
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, undefined);
});

test('Render API guard refuses to initialize without a server secret', () => {
  assert.throws(
    () => createRenderApiGuard({ secret: '' }),
    /RENDER_PROXY_SECRET is required/
  );
});
```

- [ ] **Step 2: Run the guard tests and verify the missing-module failure**

Run: `node --test test/render-api-security.test.js`

Expected: FAIL with `Cannot find module '../render-api-security'`.

- [ ] **Step 3: Implement constant-time secret verification**

Implement the guard with fixed-length digests:

```js
const { createHash, timingSafeEqual } = require('node:crypto');
const RENDER_PROXY_HEADER = 'x-warmbuddy-proxy-secret';

function digest(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function createRenderApiGuard({ secret, headerName = RENDER_PROXY_HEADER } = {}) {
  if (!secret) throw new Error('RENDER_PROXY_SECRET is required');
  const expected = digest(secret);
  return function renderApiGuard(req, res, next) {
    const supplied = req.get ? req.get(headerName) : req.headers?.[headerName];
    if (!supplied || !timingSafeEqual(expected, digest(supplied))) {
      return res.status(401).json({ error: 'Unauthorized', code: 'RENDER_API_UNAUTHORIZED' });
    }
    return next();
  };
}
```

Do not log `supplied`, `secret`, either digest, or header values.

- [ ] **Step 4: Write failing sanitizer tests**

Cover explicit output fields and nested secret removal:

```js
test('project config exposes state and hasApiKey but not the key', () => {
  const output = sanitizeProjectConfigForClient({
    enabled: true,
    apiKey: 'llm-secret',
    endpoint: 'https://llm.example',
    _desireState: { drives: { exploration: 1 } },
    _userStatus: { mood: 'ok' },
    _aiStatus: { awake: true }
  });
  assert.deepEqual(output, {
    enabled: true,
    hasApiKey: true,
    _desireState: { drives: { exploration: 1 } },
    _userStatus: { mood: 'ok' },
    _aiStatus: { awake: true }
  });
  assert.doesNotMatch(JSON.stringify(output), /llm-secret|apiKey/);
});

test('tool definitions expose configured state and strip URL credentials', () => {
  const output = sanitizeToolDefinitionForClient({
    id: 'mcp-1',
    name: 'Reader',
    description: 'Reads books',
    transport: 'streamable-http',
    url: 'https://mcp.example/run?token=url-secret&mode=safe',
    auth: { type: 'bearer', token: 'mcp-secret' }
  });
  assert.equal(output.url, 'https://mcp.example/run?mode=safe');
  assert.deepEqual(output.auth, { type: 'bearer', configured: true });
  assert.doesNotMatch(JSON.stringify(output), /url-secret|mcp-secret/);
});
```

- [ ] **Step 5: Implement whitelist serializers**

Use explicit output construction. For tools, allow only `id`, `name`, `description`, `transport`, sanitized `url`, `enabled`, and `auth`; do not spread the source object. Remove case-insensitive query names `token`, `key`, `api_key`, `apikey`, `access_token`, `auth`, `authorization`, and `secret`. Return `''` for a non-empty URL that cannot be parsed.

- [ ] **Step 6: Write failing internal fetch tests**

```js
test('internal API fetch fixes the origin and overwrites the proxy header', async () => {
  let observed;
  const internalFetch = createInternalApiFetch({
    origin: 'http://127.0.0.1:3000',
    secret: 'server-secret-at-least-32-bytes-long',
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response('{}', { status: 200 });
    }
  });
  await internalFetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-warmbuddy-proxy-secret': 'attacker-value'
    },
    body: '{}'
  });
  assert.equal(observed.url, 'http://127.0.0.1:3000/api/chat');
  assert.equal(observed.init.headers['x-warmbuddy-proxy-secret'], 'server-secret-at-least-32-bytes-long');
});

test('internal API fetch rejects non-api and absolute targets', async () => {
  const internalFetch = createInternalApiFetch({
    origin: 'http://127.0.0.1:3000',
    secret: 'server-secret-at-least-32-bytes-long',
    fetchImpl: async () => new Response('{}')
  });
  await assert.rejects(() => internalFetch('https://evil.example/api/chat'), /relative \/api path/);
  await assert.rejects(() => internalFetch('/healthz'), /relative \/api path/);
});
```

- [ ] **Step 7: Implement the fixed-origin internal fetch factory**

Normalize `origin` once, reject paths not matching `^/api(?:/|$)`, clone caller headers into a plain object, and overwrite `RENDER_PROXY_HEADER` after cloning.

- [ ] **Step 8: Run focused and full tests**

Run: `node --test test/render-api-security.test.js`

Expected: all security utility tests PASS.

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 9: Commit the security seam**

```bash
git add render-api-security.js test/render-api-security.test.js
git commit -m "feat: add Render API security seam"
```

---

### Task 2: Add and test the Vercel-to-Render proxy

**Files:**
- Create: `vercel-render-proxy.js`
- Create: `api/[...path].js`
- Create: `test/vercel-render-proxy.test.js`
- Review: `vercel.json` (expected unchanged)

**Interfaces:**
- Produces `createVercelRenderProxy({ renderOrigin, proxySecret, fetchImpl = fetch, logger = console }) -> async function handler(req, res)`.
- Consumes `RENDER_ORIGIN` and `RENDER_PROXY_SECRET` only in `api/[...path].js` at runtime.
- Injects `x-warmbuddy-proxy-secret`; never trusts an incoming value for that header.
- Streams the upstream response to the Vercel response.

- [ ] **Step 1: Write failing proxy routing and header tests**

Use local request/response test doubles or an ephemeral HTTP server. Verify the fixed upstream and narrow header policy:

```js
test('proxy forwards only to the fixed Render origin and injects its own secret', async () => {
  let observed;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: 'proxy-secret-at-least-32-bytes-long',
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-upstream-secret': 'drop-me' }
      });
    },
    logger: { info() {}, error() {} }
  });
  const response = await invokeProxy(handler, {
    method: 'POST',
    url: '/api/chat?mode=test',
    headers: {
      'content-type': 'application/json',
      cookie: 'vercel-session=private',
      authorization: 'Bearer browser-value',
      'x-warmbuddy-proxy-secret': 'spoofed'
    },
    body: '{"message":"hello"}'
  });
  assert.equal(observed.url, 'https://render.example/api/chat?mode=test');
  assert.equal(observed.init.headers['x-warmbuddy-proxy-secret'], 'proxy-secret-at-least-32-bytes-long');
  assert.equal(observed.init.headers.cookie, undefined);
  assert.equal(observed.init.headers.authorization, undefined);
  assert.equal(response.status, 201);
  assert.equal(response.headers['x-upstream-secret'], undefined);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --test test/vercel-render-proxy.test.js`

Expected: FAIL with `Cannot find module '../vercel-render-proxy'`.

- [ ] **Step 3: Implement fixed routing, methods, headers, and stable errors**

Use these exact policies:

```js
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-none-match', 'last-event-id']);
const RESPONSE_HEADERS = new Set(['content-type', 'cache-control', 'etag', 'content-disposition', 'retry-after']);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
```

Parse `req.url` against a dummy local base, reject paths outside `/api` with `404`, and reconstruct the upstream URL from the configured Render origin plus parsed pathname/search. Never call `new URL()` with a user-controlled origin.

Return stable JSON codes:

```text
405 METHOD_NOT_ALLOWED
413 REQUEST_TOO_LARGE
502 UPSTREAM_UNAVAILABLE
503 PROXY_NOT_CONFIGURED
```

- [ ] **Step 4: Write failing stream and logging tests**

Create an upstream `ReadableStream` that emits `first` immediately and `second` after the test releases a promise. Assert the proxy response receives `first` before the upstream closes. Capture logger arguments and assert they contain method, pathname, status, and duration but not the test secret, query string, Authorization, Cookie, or body text.

- [ ] **Step 5: Implement streaming and no-secret telemetry**

For web streams, convert with `Readable.fromWeb(upstream.body)` and pipe to `res`; handle `HEAD` and empty bodies with `res.end()`. Abort the upstream fetch when the client request closes. Log only a constructed object:

```js
logger.info('[render-proxy]', {
  method,
  path: parsed.pathname,
  status: upstream.status,
  durationMs: Date.now() - startedAt
});
```

Do not log the caught error object; log `{ method, path, code: 'UPSTREAM_UNAVAILABLE' }`.

- [ ] **Step 6: Add the minimal Vercel entrypoint**

`api/[...path].js` must contain only runtime configuration and export:

```js
const { createVercelRenderProxy } = require('../vercel-render-proxy');

module.exports = createVercelRenderProxy({
  renderOrigin: process.env.RENDER_ORIGIN,
  proxySecret: process.env.RENDER_PROXY_SECRET
});
```

Keep `vercel.json` unchanged and free of `env` values or public secret mappings. If a future platform limit requires duration tuning, handle that in a separately reviewed change after this security fix.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/vercel-render-proxy.test.js`

Expected: routing, spoofing, body limit, error, logging, and stream tests PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 8: Commit the Vercel proxy**

```bash
git add vercel-render-proxy.js "api/[...path].js" test/vercel-render-proxy.test.js
git commit -m "feat: proxy Vercel API requests to Render"
```

---

### Task 3: Move deployed browser requests to same-origin Vercel

**Files:**
- Modify: `public/js/app-core.js:16-18`
- Modify: `public/js/memory.js:11`
- Create: `test/frontend-private-api.test.js`

**Interfaces:**
- Produces `AppCore.BACKEND_URL === ''` for non-localhost deployments.
- Keeps local development at `http://localhost:${window.location.port || '3000'}`.
- Removes every production fallback to `warmbuddy.onrender.com` from browser JavaScript.

- [ ] **Step 1: Write the failing frontend source invariant test**

```js
test('deployed frontend uses same-origin API and contains no Render API origin', () => {
  const appCore = fs.readFileSync(path.join(repo, 'public/js/app-core.js'), 'utf8');
  const memory = fs.readFileSync(path.join(repo, 'public/js/memory.js'), 'utf8');
  const publicSources = fs.readdirSync(path.join(repo, 'public', 'js'))
    .filter(name => name.endsWith('.js'))
    .map(name => fs.readFileSync(path.join(repo, 'public', 'js', name), 'utf8'))
    .join('\n');
  assert.match(appCore, /:\s*'';/);
  assert.doesNotMatch(publicSources, /warmbuddy\.onrender\.com/);
  assert.doesNotMatch(publicSources, /RENDER_PROXY_SECRET|x-warmbuddy-proxy-secret/i);
  assert.doesNotMatch(memory, /https:\/\/warmbuddy\.onrender\.com/);
});
```

- [ ] **Step 2: Run the test and verify current hardcoded origins fail it**

Run: `node --test test/frontend-private-api.test.js`

Expected: FAIL because `app-core.js` and `memory.js` contain the Render origin.

- [ ] **Step 3: Apply the minimal same-origin changes**

Use:

```js
var BACKEND_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:' + (window.location.port || '3000')
  : '';
```

In `memory.js`, use `AppCore.BACKEND_URL` when available and `''` as the deployed fallback. Do not edit every existing fetch call.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test test/frontend-private-api.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the same-origin frontend**

```bash
git add public/js/app-core.js public/js/memory.js test/frontend-private-api.test.js
git commit -m "fix: route browser API calls through Vercel"
```

---

### Task 4: Wire Render fail-closed authentication and trusted non-browser paths

> **Release prerequisite:** Task 7 Steps 1-5 must already be complete. Stop here if the Vercel bridge and cron path have not passed their smoke checks.

**Files:**
- Modify: `server.js:1-30`
- Modify: `server.js:102-120`
- Modify: `server.js:185-231`
- Modify: `server.js:2898-2922`
- Modify: `server.js:3906-3910`
- Modify: `server.js:4536-4568`
- Modify: `server.js:4800-4803`
- Modify: `.env.example`
- Test: `test/render-api-security.test.js`

**Interfaces:**
- Consumes `createRenderApiGuard`, `createInternalApiFetch`, and `RENDER_PROXY_HEADER` from Task 1.
- Produces public `GET /healthz` and protected `/api/*`.
- Produces `302` redirects from Render UI paths to `APP_PUBLIC_ORIGIN`.
- Internal localhost calls use `internalApiFetch(path, init)`.

- [ ] **Step 1: Add failing middleware-order integration tests**

Spawn/import the app with a test `RENDER_PROXY_SECRET`. Assert:

```js
test('healthz is public while every api route requires the proxy secret', async () => {
  const health = await fetch(baseUrl + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const anonymous = await fetch(baseUrl + '/api/health');
  assert.equal(anonymous.status, 401);

  const authenticated = await fetch(baseUrl + '/api/health', {
    headers: { 'x-warmbuddy-proxy-secret': testSecret }
  });
  assert.equal(authenticated.status, 200);
});
```

Add a request with an oversized body and no secret; assert it returns `401`, proving the guard runs before `express.json()`.

- [ ] **Step 2: Run the integration tests and verify anonymous API still succeeds**

Run: `node --test test/render-api-security.test.js`

Expected: FAIL because `/api/health` currently bypasses authentication.

- [ ] **Step 3: Reorder middleware and fail closed**

At startup:

```js
const {
  createRenderApiGuard,
  createInternalApiFetch,
  sanitizeProjectConfigForClient,
  sanitizeToolDefinitionsForClient
} = require('./render-api-security');

const RENDER_PROXY_SECRET = String(process.env.RENDER_PROXY_SECRET || '').trim();
const IS_RENDER = String(process.env.RENDER || '').toLowerCase() === 'true';
const APP_PUBLIC_ORIGIN = String(process.env.APP_PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
if (!RENDER_PROXY_SECRET) throw new Error('RENDER_PROXY_SECRET is required');
if (IS_RENDER && !APP_PUBLIC_ORIGIN) throw new Error('APP_PUBLIC_ORIGIN is required on Render');

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.use(['/api', '/api/*splat'], createRenderApiGuard({ secret: RENDER_PROXY_SECRET }));
app.use(express.json({ limit: '5mb' }));
```

Use Express 5-compatible path syntax verified by a focused test. Remove global `cors()` rather than replacing it with another cross-origin policy.

- [ ] **Step 4: Retire the Render password page and static app serving**

Remove `ACCESS_PASSWORD`, password HTML, cookie authentication, and `cookie-parser`. On Render, do not mount `express.static('public')`; add a redirect handler after API routes that targets `APP_PUBLIC_ORIGIN`, copying only non-empty `project` and `chat` query parameters with `URLSearchParams`. Never copy `pwd`. Outside Render, retain `express.static('public')` for local same-origin development without the old password page.

Remove `cookie-parser` and `cors` from `package.json` only after `rg -n "cookie-parser|\bcors\b" . -g "!node_modules/**"` confirms no remaining runtime imports.

- [ ] **Step 5: Replace localhost API calls with the authenticated helper**

Create once after `PORT` is known or make the origin lazy without changing behavior:

```js
const internalApiFetch = createInternalApiFetch({
  origin: `http://127.0.0.1:${PORT}`,
  secret: RENDER_PROXY_SECRET
});
```

Replace only the four current localhost calls to `/api/chat` (two locations), `/api/log-token-call`, and `/api/projects/sync-configs`. Preserve method, content type, body, fire-and-forget behavior, and existing error handling.

- [ ] **Step 6: Update environment names without values**

In `.env.example`, add:

```dotenv
# Server-only shared credential; set the same random value in Vercel and Render.
RENDER_PROXY_SECRET=
# Vercel only: fixed upstream origin.
RENDER_ORIGIN=https://warmbuddy.onrender.com
# Render only: canonical authenticated browser entry.
APP_PUBLIC_ORIGIN=https://warmbuddy.vercel.app
NTFY_CLICK_BASE_URL=https://warmbuddy.vercel.app
```

Remove `ACCESS_PASSWORD`. Do not include an example secret value.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/render-api-security.test.js`

Expected: public health, protected API, middleware order, redirect allowlist, and internal fetch integration tests PASS.

Run: `npm test`

Expected: all tests PASS after existing route tests set the test proxy-secret header.

- [ ] **Step 8: Commit Render lockdown wiring**

```bash
git add server.js package.json package-lock.json .env.example test/render-api-security.test.js
git commit -m "fix: require trusted proxy access on Render API"
```

---

### Task 5: Sanitize credential-bearing read responses and preserve local MCP tokens

**Files:**
- Modify: `server.js:2924-2931`
- Modify: `server.js` at `/api/projects/configs`
- Modify: `server.js:5227-5234`
- Modify: `server.js:5278-5301`
- Modify: `public/js/toolkit.js:398-416`
- Modify: `test/render-api-security.test.js`
- Modify: `test/frontend-private-api.test.js`

**Interfaces:**
- Consumes `sanitizeProjectConfigForClient` and `sanitizeToolDefinitionsForClient` from Task 1.
- Produces `{ config: SanitizedProjectConfig|null }` for project reads.
- Produces `{ definitions: SanitizedToolDefinition[] }` and `{ tools: SanitizedToolDefinition[] }` for toolkit reads.
- Produces `mergeServerDefinition(local, server) -> definition` in `public/js/toolkit.js`, preserving `local.auth.token`.

- [ ] **Step 1: Add failing route-level response tests**

Seed representative project/tool records containing known sentinels `READ_API_KEY_SENTINEL`, `READ_MCP_TOKEN_SENTINEL`, and a URL token. Call each read path with the Render proxy header and recursively assert:

```js
function assertNoCredentialSentinels(value) {
  const json = JSON.stringify(value);
  assert.doesNotMatch(json, /READ_API_KEY_SENTINEL|READ_MCP_TOKEN_SENTINEL|URL_TOKEN_SENTINEL/);
}
```

Verify configured booleans remain true and state fields consumed by `public/js/sync.js` remain present.

- [ ] **Step 2: Run tests and verify the existing raw responses fail**

Run: `node --test test/render-api-security.test.js`

Expected: FAIL at `/api/projects/sync-configs`, `/api/toolkit/definitions`, or `/api/tools/enabled` because raw records are returned.

- [ ] **Step 3: Apply serializers at every response seam**

Replace raw response values with:

```js
res.json({ config: sanitizeProjectConfigForClient(freshConfig) });
res.json({ definitions: sanitizeToolDefinitionsForClient(data.value || []) });
res.json({ tools: sanitizeToolDefinitionsForClient(enabledDefs) });
```

Inspect `/api/projects/configs` and route every returned project config through the same serializer. Do not mutate database objects before internal business logic uses them; sanitize only when building client responses.

- [ ] **Step 4: Add a failing frontend merge test**

Extract or expose a pure merge helper and test:

```js
test('sanitized server tool metadata does not erase the local MCP token', () => {
  const local = {
    id: 'reader',
    name: 'Old name',
    auth: { type: 'bearer', token: 'LOCAL_TOKEN_SENTINEL' }
  };
  const server = {
    id: 'reader',
    name: 'New name',
    auth: { type: 'bearer', configured: true }
  };
  const merged = mergeServerDefinition(local, server);
  assert.equal(merged.name, 'New name');
  assert.equal(merged.auth.token, 'LOCAL_TOKEN_SENTINEL');
  assert.equal(merged.auth.configured, true);
});
```

- [ ] **Step 5: Implement the narrow client merge**

Merge top-level server metadata over local metadata, then merge `auth` separately. Copy `local.auth.token` only when it is a non-empty string. Never create `auth.token` from `configured`, a masked display value, or any server field other than an actual local token.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test test/render-api-security.test.js test/frontend-private-api.test.js`

Expected: all response and local-token tests PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 7: Commit response sanitization**

```bash
git add server.js public/js/toolkit.js test/render-api-security.test.js test/frontend-private-api.test.js
git commit -m "fix: redact credentials from configuration reads"
```

---

### Task 6: Remove credential-bearing diagnostics and body dumps

**Files:**
- Modify: `server.js:1134-1143`
- Modify: `server.js:1512-1569`
- Modify: `server.js:2076-2100`
- Modify: `server.js:2351-2354`
- Modify: `server.js` at VAPID initialization diagnostics
- Modify: `claude-code-gateway.js:1-8`
- Modify: `claude-code-gateway.js:239-252`
- Modify: `test/claude-code-gateway.test.js`
- Create: `test/credential-logging.test.js`

**Interfaces:**
- Logging may emit credential configured booleans and non-sensitive operational metadata only.
- No logger call receives raw headers, bodies, parsed MCP content, API keys, tokens, private keys, hashes, lengths, or prefixes.

- [ ] **Step 1: Write failing no-secret logging tests**

Capture `console.log`, `console.warn`, and `console.error` around representative connection-test, MCP, Agent Gateway, and initialization paths. Use unique sentinels and assert the flattened log does not contain the sentinel, its prefix, or its SHA-256 digest:

```js
assert.doesNotMatch(logText, /LOG_SECRET_SENTINEL/);
assert.doesNotMatch(logText, new RegExp(createHash('sha256').update(secret).digest('hex')));
assert.doesNotMatch(logText, /tokenLength|tokenSha256|raw body|request headers|Raw sample/i);
```

Update the existing Agent Gateway diagnostic test to expect only `tokenConfigured` and request outcome metadata.

- [ ] **Step 2: Run the logging tests and verify current diagnostics fail them**

Run: `node --test test/credential-logging.test.js test/claude-code-gateway.test.js`

Expected: FAIL because current logs contain credential prefixes, lengths/hashes, raw body diagnostics, or raw stream samples.

- [ ] **Step 3: Remove secret-adjacent diagnostics**

- Delete `sha256()` and `createHash` from `claude-code-gateway.js` if unused after diagnostics removal.
- Replace Agent Gateway auth diagnostics with `{ tokenConfigured: Boolean(gatewayToken) }`.
- Replace test-connection header logging with provider, endpoint host, model, and `credentialConfigured: Boolean(apiKey)` only.
- Replace MCP header/body/result logs with URL host, method, transport, HTTP status, content type, tool count, and stable parse/error codes.
- Remove the low-chunk raw stream sample; retain chunk counts and format only.
- Never print generated VAPID private keys, private-key lengths, prefixes, or full `.env` assignment suggestions. Public VAPID key may be identified as configured, but use a boolean for consistency.

- [ ] **Step 4: Perform a source-level forbidden-log scan**

Run:

```powershell
rg -n "slice\(0,\s*(8|15|1000|1200)\)|tokenSha256|tokenLength|authorizationLength|raw body|Raw sample|PRIVATE_KEY=|request headers" server.js claude-code-gateway.js
```

Expected: no credential/debug-body logging matches. Review any unrelated match manually before accepting it.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test test/credential-logging.test.js test/claude-code-gateway.test.js`

Expected: PASS and captured logs contain no sentinels or hashes.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 6: Commit logging hardening**

```bash
git add server.js claude-code-gateway.js test/claude-code-gateway.test.js test/credential-logging.test.js
git commit -m "fix: remove credential-bearing diagnostics"
```

---

### Task 7: Write the deployment runbook and execute the bridge release

**Files:**
- Create: `docs/vercel-render-private-api-runbook.md`
- Review: `.env.example`

**Interfaces:**
- Consumes all code from Tasks 1-6.
- Produces a value-free operator checklist for Vercel, Render, cron-job.org, smoke verification, rollback, and secret rotation.
- Does not store any real secret in the repository.

- [ ] **Step 1: Write the runbook with exact dashboard fields and commands**

The runbook must contain these sections and exact settings:

```text
Vercel Production + Preview:
  RENDER_ORIGIN=https://warmbuddy.onrender.com
  RENDER_PROXY_SECRET=<same generated value as Render>
  Deployment Protection: All Deployments

Render:
  RENDER_PROXY_SECRET=<same generated value as Vercel>
  APP_PUBLIC_ORIGIN=https://warmbuddy.vercel.app
  NTFY_CLICK_BASE_URL=https://warmbuddy.vercel.app

Render Health Check Path:
  /healthz

cron-job.org target:
  https://warmbuddy.vercel.app/api/cron/check
  x-vercel-protection-bypass: <Vercel automation bypass value>
```

Document generation using a local password manager or `openssl rand -base64 32`; explicitly say never paste the output into shell history, chat, logs, screenshots, or the repository.

- [ ] **Step 2: Add bridge-release preflight checks**

Run before deployment:

```powershell
npm test
git diff --check
rg -n "RENDER_PROXY_SECRET|x-warmbuddy-proxy-secret|warmbuddy\.onrender\.com" public
```

Expected: tests pass; diff check is clean; the `public` scan finds no proxy secret name/header and no Render API origin.

- [ ] **Step 3: Configure server-side environment variables**

Generate one new secret outside the repository. Set it in Vercel Production/Preview and Render. Set `RENDER_ORIGIN` only in Vercel. Set `APP_PUBLIC_ORIGIN` and `NTFY_CLICK_BASE_URL` in Render. Confirm no variable is prefixed `NEXT_PUBLIC_`, `VITE_`, or otherwise exposed at build time.

- [ ] **Step 4: Deploy Vercel bridge before Render enforcement**

Deploy the Vercel Function and same-origin frontend while the currently deployed Render version still permits existing requests. Verify authenticated JSON endpoints and chat SSE through `https://warmbuddy.vercel.app`.

- [ ] **Step 5: Move cron-job.org to Vercel**

Create or rotate a Vercel Protection Bypass for Automation value, store it only in cron-job.org, update the target URL/header, trigger one manual run, and verify a successful cron response without exposing the bypass value.

- [ ] **Step 6: Commit the runbook**

```bash
git add docs/vercel-render-private-api-runbook.md
git commit -m "docs: add private API deployment runbook"
```

---

### Task 8: Execute Render lockdown and production acceptance

**Files:**
- Review: all files modified in Tasks 1-7
- Operational changes: Render service settings, Vercel deployment protection, cron-job.org target

**Interfaces:**
- Produces the final protected production data flow described by the spec.
- Direct Render `/api/*` access returns `401`; Vercel-authenticated access remains functional.

- [ ] **Step 1: Verify the bridge before locking Render**

From an authenticated browser, verify page load, project sync, one normal JSON request, one streamed chat, one configured MCP tool call, and one notification click. Inspect the browser network panel and confirm all application API requests target the Vercel origin.

- [ ] **Step 2: Deploy the Render lockdown release**

Deploy the commit containing Tasks 1, 4, 5, and 6 after Vercel bridge verification. Set Render Health Check Path to `/healthz`. Do not remove either copy of `RENDER_PROXY_SECRET` during deployment.

- [ ] **Step 3: Run unauthenticated Render checks**

Run without the secret:

```powershell
curl.exe -i https://warmbuddy.onrender.com/healthz
curl.exe -i https://warmbuddy.onrender.com/api/health
curl.exe -i -X POST https://warmbuddy.onrender.com/api/projects/sync-configs -H "content-type: application/json" -d "{\"projectId\":\"security-check\"}"
curl.exe -i https://warmbuddy.onrender.com/api/toolkit/definitions
```

Expected: `/healthz` is `200` with only `{"status":"ok"}`; every `/api/*` request is `401` with `RENDER_API_UNAUTHORIZED` and no sensitive detail.

- [ ] **Step 4: Run Vercel authenticated acceptance checks**

Through an authenticated Vercel browser session:

- Page and PWA assets load normally.
- `/api/health` returns `200`.
- Chat emits its first SSE content before the request completes.
- Project sync succeeds.
- Configuration responses contain `hasApiKey`/`configured` but no complete API key or Token.
- Current-device MCP configuration retains its local token and tool execution succeeds.
- A new clean browser profile does not receive a complete server-stored MCP Token.

- [ ] **Step 5: Verify platform protection and redirect behavior**

Open Vercel logged out and confirm Vercel Authentication blocks access. Confirm All Deployments remains enabled and there are no unintended public deployment exceptions or Shareable Links. Open the Render root with `?project=p1&chat=c1&pwd=old` and verify the redirect target preserves `project` and `chat` but omits `pwd`.

- [ ] **Step 6: Verify trusted automated paths**

Trigger cron-job.org once and verify success through Vercel. Trigger or wait for one Render internal proactive path and confirm the authenticated localhost `/api` call succeeds. Confirm Render health remains healthy on `/healthz`.

- [ ] **Step 7: Inspect production logs for forbidden content**

Search the deployment interval for `Authorization`, `apiKey`, `tokenSha256`, `raw body`, `Raw sample`, known test sentinels, and request-body fragments. Expected: no credential value, prefix, hash, length, or raw body. Boolean `configured` state and stable error codes are allowed.

- [ ] **Step 8: Run final repository verification**

Run:

```powershell
npm test
git diff --check
git status --short
rg -n "warmbuddy\.onrender\.com|RENDER_PROXY_SECRET|x-warmbuddy-proxy-secret" public
```

Expected: tests pass, diff is clean, working tree contains only intentional changes, and the `public` scan has no matches.

- [ ] **Step 9: Record acceptance without secrets**

Append deployment timestamps, Vercel deployment identifier, Render deployment identifier, HTTP status results, cron result, and reviewer name to the runbook. Do not record either shared secret or Automation Bypass value.

- [ ] **Step 10: Keep rollback bounded**

If Vercel requests fail after Render lockdown, roll Render back to the immediately preceding deployment while leaving Vercel Proxy and both environment variables intact. Diagnose and redeploy; do not work around the failure by placing `RENDER_PROXY_SECRET` in browser code or adding an anonymous Render bypass.

---

## Self-Review Checklist

- [ ] Every requirement in the design spec maps to Tasks 1-8.
- [ ] No task migrates LLM API keys or MCP tokens into a new vault.
- [ ] No task adds rate limiting, per-user authorization, RLS work, or database migrations.
- [ ] Proxy, Render guard, internal calls, sanitization, local token preservation, logging, cron, health, redirect, rollout, and rollback are all covered.
- [ ] `RENDER_PROXY_SECRET` has one header name everywhere: `x-warmbuddy-proxy-secret`.
- [ ] Project config serializer and tool serializer signatures are identical across tasks.
- [ ] The plan contains no real secret or Automation Bypass value.
- [ ] The bridge deploys before Render lockdown.
