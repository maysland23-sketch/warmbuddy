# Claude Code Test MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fixed `claude-code-test` WarmBuddy project that routes normal chat to the Android Agent Gateway and exposes the first 11 co-reading-kit tools without changing proactive messages.

**Architecture:** The browser keeps building the existing canonical WarmBuddy context and sends it to a dedicated backend route. The backend owns the Gateway URL/token, serializes the canonical context into one bounded prompt, calls the Gateway JSON run endpoint, and adapts the result back to the existing WarmBuddy SSE shape. The Gateway remains the only process allowed to launch Claude Code and MCP; its fixed project, isolated-run default, tool allowlist, and `/root/neverland/books` path policy are deployment requirements.

**Tech Stack:** Node.js 22, CommonJS, Express 5, native `fetch`, Node test runner, existing vanilla JavaScript frontend, Android/Termux Gateway using Claude CLI and co-reading-kit MCP.

**Spec:** `C:\Users\ma'y's\ai-app\开发记录\最小可用 MVP.md`

## Global Constraints

- The stable frontend project id is exactly `claude-code-test`.
- The Gateway project id is exactly `warmbuddy-test`.
- Browser requests never contain `AGENT_GATEWAY_TOKEN`, Gateway credentials, arbitrary Gateway URLs, model flags, cwd values, or tool definitions.
- The initial MCP allowlist is exactly `reading_import_book`, `reading_list_books`, `reading_get_manifest`, `reading_search`, `reading_search_exact`, `reading_get_chunk`, `reading_get_progress`, `reading_read_note`, `reading_resume_book`, `reading_update_progress`, and `reading_update_note`.
- `reading_import_book` may import only from `/root/neverland/books`; the Gateway must reject traversal, absolute paths outside that root, and symlink escapes before MCP execution.
- The Gateway must not import a file unless the user explicitly named it in the request.
- Gateway prompts must state: `reading_import_book 只能从 ~/neverland/books/ 导入`, `不得读取任意其他路径`, and `不得把用户未明确指定的文件当作书籍导入`.
- The MVP uses `resume:false`/per-request isolation and does not depend on Claude Code session resume.
- Claude Code must receive the WarmBuddy harness through `--append-system-prompt`; do not replace or patch the CLI harness.
- Do not alter proactive cron, shadow-message construction, proactive parsing, provider model registry, or existing OpenAI/Anthropic routes.
- MVP does not add full-site authentication or rate limiting; it does enforce Gateway secret isolation, fixed routing, timeout, and upstream failure handling.

---

### Task 1: Add and test the Agent Gateway client seam

**Files:**
- Create: `claude-code-gateway.js`
- Test: `test/claude-code-gateway.test.js`

**Interfaces:**
- Produces `createAgentGatewayClient(options)` returning `run({ conversationId, prompt }) -> Promise<{ content, sessionId, usage, resumed }>`.
- Produces `AgentGatewayError` with `status`, `code`, and `cause` fields for HTTP, timeout, malformed response, and configuration failures.
- The client validates and sends only `{ projectId: 'warmbuddy-test', conversationId, prompt, resume: false }` to `${AGENT_GATEWAY_URL}/v1/agent/run` with `Authorization: Bearer ${AGENT_GATEWAY_TOKEN}`.

- [x] **Step 1: Write the failing client tests**

```js
test('run posts the fixed project and isolated-run contract', async () => {
  let request;
  const client = createAgentGatewayClient({
    baseUrl: 'https://gateway.test/',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, result: 'done', sessionId: null, resumed: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await client.run({ conversationId: 'c1', prompt: 'hello' });

  assert.equal(result.content, 'done');
  assert.equal(request.url, 'https://gateway.test/v1/agent/run');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.deepEqual(request.body, {
    projectId: 'warmbuddy-test',
    conversationId: 'c1',
    prompt: 'hello',
    resume: false
  });
});
```

```js
test('run converts Gateway failure and timeout into typed errors', async () => {
  const failed = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'denied', code: 'PROJECT_NOT_ALLOWED' }), { status: 403 })
  });
  await assert.rejects(() => failed.run({ conversationId: 'c1', prompt: 'hello' }), error => {
    assert.equal(error.name, 'AgentGatewayError');
    assert.equal(error.status, 403);
    assert.equal(error.code, 'PROJECT_NOT_ALLOWED');
    return true;
  });

  const timedOut = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  await assert.rejects(() => timedOut.run({ conversationId: 'c1', prompt: 'hello' }), error => error.code === 'AGENT_GATEWAY_TIMEOUT');
});
```

- [x] **Step 2: Run the focused tests and verify the expected missing-module failure**

Run: `node --test test/claude-code-gateway.test.js`

Expected: FAIL because `../claude-code-gateway` does not exist yet.

- [x] **Step 3: Implement the minimal deep client**

Implement URL normalization, required base URL/token checks, a per-request `AbortController`, JSON parsing, `ok`/`result` validation, and typed errors. Do not expose the token in error messages. Keep `projectId` and `resume:false` internal constants rather than accepting them from callers.

- [x] **Step 4: Run focused and full tests**

Run: `node --test test/claude-code-gateway.test.js`

Expected: PASS.

Run: `npm test`

Expected: all existing tests and the new client tests PASS.

---

### Task 2: Add the fixed backend Gateway SSE route

**Files:**
- Modify: `server.js:1-30` for the client import and Gateway configuration
- Modify: `server.js` near `POST /api/chat/stream` for `POST /api/agent/stream`
- Test: `test/agent-stream-route.test.js`

**Interfaces:**
- Consumes `createAgentGatewayClient` from Task 1.
- Accepts `{ projectId: 'claude-code-test', windowId, interactionId, messages }`.
- Produces the existing SSE protocol: `data: {"text":"..."}` followed by `data: [DONE]`; errors are JSON SSE payloads with stable HTTP status and no secrets.

- [x] **Step 1: Write the failing route tests**

```js
test('agent stream forwards canonical context and adapts Gateway JSON to WarmBuddy SSE', async () => {
  const gateway = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    assert.equal(body.projectId, 'warmbuddy-test');
    assert.equal(body.conversationId, 'chat-1');
    assert.equal(body.resume, false);
    assert.match(body.prompt, /CURRENT USER MESSAGE:/);
    assert.match(body.prompt, /hello/);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: 'Gateway reply', resumed: false }));
  });
  const api = await startAppWithAgentGateway(gateway);

  const response = await fetch(api.url + '/api/agent/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: 'claude-code-test', windowId: 'chat-1', interactionId: 'i1',
      messages: [{ role: 'system', content: 'SYSTEM' }, { role: 'user', content: 'hello' }]
    })
  });
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /data: {"text":"Gateway reply"}/);
  assert.match(text, /data: \[DONE\]/);
  assert.doesNotMatch(text, /secret|Bearer/);
});
```

```js
test('agent stream rejects other projects and maps Gateway failures', async () => {
  const api = await startAppWithAgentGateway({ status: 502, body: { error: 'unavailable', code: 'UPSTREAM_UNAVAILABLE' } });
  const response = await fetch(api.url + '/api/agent/stream', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'reading', windowId: 'chat-1', messages: [{ role: 'user', content: 'hello' }] })
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /claude-code-test/);
});
```

- [x] **Step 2: Run focused tests and verify the expected route failure**

Run: `node --test test/agent-stream-route.test.js`

Expected: FAIL because the route and test harness seam do not exist yet.

- [x] **Step 3: Implement the route and prompt serializer**

Add a fixed route that only accepts `claude-code-test`, validates a non-empty `windowId`, a bounded messages array, and roles `system|user|assistant`. Serialize the existing canonical messages with explicit role labels, retain the latest user message, and cap the serialized request below the existing 5 MB JSON limit. Do not accept API key, endpoint, model, tool definitions, Gateway URL, or Gateway token from the browser.

Set `AGENT_GATEWAY_TIMEOUT_MS` to a bounded default of 120000 ms. On success, emit one text SSE event and `[DONE]`. On Gateway errors, emit an error SSE event if headers are already sent; otherwise return JSON with 502 for upstream failures and 504 for timeout. Close/abort the Gateway request when the browser disconnects.

- [x] **Step 4: Run focused and full tests**

Run: `node --test test/agent-stream-route.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

---

### Task 3: Create the stable frontend test project and route its normal chat

**Files:**
- Modify: `public/js/app-core.js` near project initialization/migration
- Modify: `public/js/chat.js` near `triggerAIResponse()` and the fetch request
- Modify: `public/js/settings.js` near project API configuration rendering
- Test: `test/frontend-claude-code-test.test.js`

**Interfaces:**
- Consumes the fixed project id `claude-code-test` and existing `ChatModule` canonical message/context construction.
- Produces a stable project visible in the existing project UI, with the current chat/window UI reused and normal send routed to `/api/agent/stream`.

- [x] **Step 1: Write the failing static behavior tests**

```js
test('frontend source defines and preserves the stable Claude Code test project', () => {
  const appCore = fs.readFileSync(path.join(repo, 'public/js/app-core.js'), 'utf8');
  const chat = fs.readFileSync(path.join(repo, 'public/js/chat.js'), 'utf8');
  const settings = fs.readFileSync(path.join(repo, 'public/js/settings.js'), 'utf8');
  assert.match(appCore, /claude-code-test/);
  assert.match(chat, /\/api\/agent\/stream/);
  assert.match(chat, /claude-code-test/);
  assert.match(settings, /claude-code-test/);
});
```

- [x] **Step 2: Run focused test and verify it fails**

Run: `node --test test/frontend-claude-code-test.test.js`

Expected: FAIL because the fixed project and route are not in the frontend source.

- [x] **Step 3: Implement the smallest UI integration**

At startup/migration, create the project only if no project with id `claude-code-test` exists, using the existing project shape and one default chat/window. Mark it with a local runtime kind such as `runtime: 'agent-gateway'` and preserve it on later migrations. In `triggerAIResponse()`, keep all existing static prompt, dynamic context, recent messages, interaction id, and window id construction; branch only at the final request so this project sends `{ projectId, windowId, interactionId, messages }` to `/api/agent/stream` and continues consuming the existing `data: ` SSE text format. Do not send provider credentials or MCP definitions.

Hide or disable provider API key, endpoint, and model controls for this project while leaving other projects unchanged. Keep the stable project selectable in the current UI and do not create a second chat UI.

- [x] **Step 4: Run focused and full tests**

Run: `node --test test/frontend-claude-code-test.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

---

### Task 4: Keep the test project out of proactive config synchronization

**Files:**
- Modify: `public/js/sync.js` in `syncProjectConfigToBackend`
- Modify: `.env.example` with non-secret Gateway variable names
- Test: `test/sync-agent-gateway.test.js`

**Interfaces:**
- Consumes the frontend runtime marker from Task 3.
- Produces no `project_configs` sync request for `claude-code-test`; message sync remains available for the existing chat history path.

- [x] **Step 1: Write the failing synchronization test**

```js
test('agent-gateway test project does not enter proactive project config sync', () => {
  const sync = fs.readFileSync(path.join(repo, 'public/js/sync.js'), 'utf8');
  assert.match(sync, /runtime/);
  assert.match(sync, /agent-gateway/);
  assert.match(sync, /syncProjectConfigToBackend/);
});
```

- [x] **Step 2: Run focused test and verify it fails**

Run: `node --test test/sync-agent-gateway.test.js`

Expected: FAIL because sync currently treats every project as a provider-config project.

- [x] **Step 3: Implement the narrow sync guard and environment documentation**

Return early from `syncProjectConfigToBackend` when the project runtime is `agent-gateway`; leave `syncMessagesToBackend` unchanged. Add `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_TOKEN`, `AGENT_GATEWAY_TIMEOUT_MS`, and `AGENT_GATEWAY_PROJECT_ID=warmbuddy-test` to `.env.example` without values for secrets. Do not change `checkDesireCron` or `checkTodoWakeUps`.

- [x] **Step 4: Run focused and full tests**

Run: `node --test test/sync-agent-gateway.test.js`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

---

### Task 5: Record and apply the Android Gateway deployment contract

**Files:**
- Create: `docs/agent-gateway-warmbuddy-test.md`
- External deployment file: `/root/neverland/gateway/server.mjs`
- External deployment file: `/root/neverland/gateway/.env`

**Interfaces:**
- Consumes the backend request contract from Tasks 1–2.
- Produces a Gateway that accepts `warmbuddy-test`, defaults each request to `resume:false`, passes the fixed system policy through `--append-system-prompt`, and exposes exactly the 11 approved MCP tools.

- [x] **Step 1: Add the deployment contract document**

Document the exact request, response, and SSE examples, the fixed values, and the manual verification commands below. Keep credentials out of the document.

```text
curl -sS https://agent.maysneverland.com/health
curl -sS -X POST https://agent.maysneverland.com/v1/agent/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"projectId":"warmbuddy-test","conversationId":"chat-1","prompt":"列出可用书籍","resume":false}'
```

- [ ] **Step 2: Update the external Gateway allowlist and policy**

In `/root/neverland/gateway/server.mjs`, add `warmbuddy-test` to the fixed project map, reject any other project id, use `resume:false` unless explicitly supported by the contract, pass `--append-system-prompt` with the fixed WarmBuddy/MCP path policy, and set `allowedTools` to exactly the 11 names in the global constraints. Validate the `reading_import_book` path before launching MCP so canonical resolution stays inside `/root/neverland/books` and reject user prompts that omit an explicit target filename for imports.

- [ ] **Step 3: Verify the Gateway contract from the Android host**

Run the health check and one harmless `reading_list_books` request. Then run an import with a named file under `/root/neverland/books`, and confirm traversal, an outside absolute path, a symlink to an outside file, and an unnamed import are rejected. Confirm the Gateway logs contain no bearer token.

---

### Task 6: Final verification and review

**Files:**
- Review: all modified files from Tasks 1–5

- [x] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests PASS with no new warnings.

- [x] **Step 2: Verify the proactive path is unchanged**

Run: `git diff -- server.js public/js/sync.js`

Expected: changes are limited to the new normal-chat Gateway route/client configuration and the narrow `agent-gateway` config-sync exclusion; no cron, shadow prompt, proactive parser, or proactive persistence code changes appear.

- [x] **Step 3: Verify secret and routing invariants**

Run: `rg -n "AGENT_GATEWAY_TOKEN|agent-gateway|claude-code-test|warmbuddy-test|append-system-prompt|reading_import_book" server.js claude-code-gateway.js public docs .env.example`

Expected: the token is read only by backend Gateway client configuration, the browser code contains no Gateway token or URL, and the fixed ids/tool policy are present only in the intended seams/docs.

- [x] **Step 4: Review the diff for scope**

Run: `git diff --check` and `git diff --stat`

Expected: no whitespace errors and only the MVP files are changed.
