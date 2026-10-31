# WarmBuddy E1-A Native Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict WB support for Gateway `activity/source` receipts, server-controlled legacy/native Codex web mode, receipt UI, and terminal-safe synchronization.

**Architecture:** Keep Render as a transparent, cancellation-aware SSE proxy. Make `codex-gateway.js` the server protocol boundary and `public/js/codex.js` the browser protocol boundary; both accept only the old five events plus the allowlisted E1-A events. Store bounded receipt summaries in Codex message metadata on the current user message, while leaving prompt construction and completed-only action commits separate.

**Tech Stack:** Node.js CommonJS backend, Express, Vercel raw streaming proxy, browser ES5-style modules loaded by `public/index.html`, Node `node:test`, browser VM contract tests.

**Spec:** `docs/superpowers/specs/2026-10-31-e1-native-web-design.md`

## Global Constraints

- `CODEX_WEB_MODE` accepts only `legacy` or `native` and defaults to `legacy`.
- Browser requests remain limited to `prompt` and optional `sessionId`.
- Gateway native mode is separately controlled by `CODEX_GATEWAY_E1_NATIVE_WEB=1`; production remains off.
- Only bounded public receipt fields may cross the WB boundary; never expose thread IDs, raw tool results, query text, session sidecars, credentials, absolute paths, or signed URLs.
- Preserve cancellation, backpressure, timeout, session isolation, version/terminal precedence, message ordering, and completed-only side effects.

## Review Focus

- A source after activity completed must attach to the same request/activity without title/refId mismatch — covered by adapter and frontend receipt tests.
- A redacted or display-only URL must render as text, never as an href — covered by server normalization and UI HTML tests.
- A native round with no activity must not fall back to legacy search — covered by Codex mode-routing tests.
- An activity left running when the stream fails, ends, cancels, or reloads must settle locally — covered by terminal/reload tests.
- A zero-message failed/unknown turn must still schedule sync without invoking actions — covered by Codex turn tests.

---

### Task 1: Strict Gateway receipt adapter

**Files:**
- Modify: `codex-gateway.js`
- Test: `test/codex-gateway.test.js`

**Interfaces:**
- Produces: `normalizeCodexWebMode(value)`, `consumeCodexSse(..., { webMode })`, and safe `activity/source` event payloads for existing `onEvent` callers.

- [x] **Step 1: Write failing tests** for native activity/source events, cross-chunk parsing, late source ordering, redaction, duplicate/unknown/over-limit events, and legacy rejection of new event types.
- [x] **Step 2: Run the focused Gateway tests** and confirm failures are caused by missing native event support.
- [x] **Step 3: Implement mode parsing and bounded activity/source validation** while retaining old event shapes and error mapping.
- [x] **Step 4: Run the focused Gateway tests** and confirm all pass.

### Task 2: Server mode endpoint and Render forwarding contract

**Files:**
- Modify: `server.js`
- Modify: `codex-gateway.js`
- Test: `test/codex-stream-route.test.js`
- Test: `test/vercel-render-proxy.test.js`

**Interfaces:**
- Produces: `GET /api/codex/config` returning only `{webMode}`; Codex stream uses the startup-selected mode; Render proxy continues raw SSE forwarding and cancellation behavior.

- [x] **Step 1: Write failing route/proxy tests** for default/strict mode, no sensitive config leakage, and byte-preserving activity/source SSE forwarding.
- [x] **Step 2: Run focused route/proxy tests** and confirm failures.
- [x] **Step 3: Add startup mode selection and the read-only config route; pass mode to the Gateway adapter without adding request-body fields.**
- [x] **Step 4: Run focused route/proxy tests** and confirm pass.

### Task 3: Frontend decoder and mode-aware search routing

**Files:**
- Modify: `public/js/codex.js`
- Modify: `public/js/chat.js`
- Modify: `public/index.html`
- Test: `test/codex-frontend.test.js`
- Test: `test/codex-context.test.js`
- Test: `test/codex-frontend-loopback.test.js`

**Interfaces:**
- Produces: strict browser activity/source decoding, per-turn no-store getWebMode, configuration failures that stop before Gateway requests, native mode bypass of [[SEARCH]]/api/search, and legacy behavior unchanged.

- [x] **Step 1: Write failing frontend tests** for mode fetch, native no-fallback behavior, legacy two-pass behavior, fragmented events, source association, invalid URLs, and malicious text.
- [x] **Step 2: Run focused frontend tests** and confirm failures.
- [x] **Step 3: Implement browser decoding and pass `webMode` through `runTurn` without changing request JSON.**
- [x] **Step 4: Make Codex dynamic context emit the native-tool instruction only in native mode; preserve ordinary model and legacy Codex instructions.**
- [x] **Step 5: Run focused frontend/context tests** and confirm pass.

### Task 4: Activity/source UI and synchronized receipt metadata

**Files:**
- Modify: `public/js/codex.js`
- Modify: `public/js/chat.js`
- Modify: `public/js/sync.js`
- Modify: `codex-message-sync.js`
- Modify: `public/index.html`
- Test: `test/codex-message-sync.test.js`
- Test: `test/codex-sync-frontend.test.js`
- Test: `test/codex-frontend.test.js`

**Interfaces:**
- Produces: bounded `_codexReceipts`/`metadata.receipts` shape, local activity settlement, and safe collapsible receipt/source rendering.

- [x] **Step 1: Write failing metadata/UI tests** for allowlist, bounds, reload hydration, activity/source association, redacted links, escaped HTML, empty/unknown results, and no receipt fallback.
- [x] **Step 2: Run focused metadata/UI tests** and confirm failures.
- [x] **Step 3: Add shared-shape server and frontend metadata normalization with bounded receipts.**
- [x] **Step 4: Record receipts on the current user message, mark later source arrivals dirty, and hydrate them from cloud messages without changing prompt history.**
- [x] **Step 5: Render the receipt card using escaped text and revalidated URLs; keep tool completion distinct from full-read success.**
- [x] **Step 6: Run focused metadata/UI tests** and confirm pass.

### Task 5: Terminal/reload synchronization and regression coverage

**Files:**
- Modify: `public/js/codex.js`
- Modify: `public/js/sync.js` if needed for terminal metadata
- Test: `test/codex-frontend.test.js`
- Test: `test/codex-reload-startup.test.js`
- Test: `test/codex-context.test.js`

**Interfaces:**
- Produces: explicit sync scheduling for zero-message failed/unknown turns and local settlement for completion, error, EOF, network loss, cancellation, and reload.

- [x] **Step 1: Write failing tests** for zero-assistant-message failure/unknown sync, activity interruption on each terminal path, reload interruption, completed-only action commit, and existing sort protection.
- [x] **Step 2: Run focused tests** and confirm the zero-message sync gap and activity settlement failures.
- [x] **Step 3: Add the narrow catch/reload sync and receipt settlement changes without altering action commit gates.**
- [x] **Step 4: Run focused tests** and confirm pass.

### Task 6: Full proportional verification and diff review

**Files:**
- Test: existing `test/*.test.js`

- [x] **Step 1: Run targeted protocol, route, proxy, frontend, sync, and reload tests.**
- [x] **Step 2: Run the repository test command `npm test` as required by the TDD workflow; record any unrelated failures explicitly.**
- [x] **Step 3: Run syntax checks for modified JavaScript and inspect `git diff --check` plus the full diff for protocol leaks, unintended search changes, and branch scope.**

### Review fixes

- [x] Re-read /api/codex/config for every new turn with explicit no-store request/response headers; stop on missing, invalid, malformed, unavailable, or non-success configuration.
- [x] Compact valid receipts above 64 KiB deterministically while preserving activity identity/terminal state and carrying an omission marker through sync and hydration.
- [x] Use end-of-action UI copy for completed/unknown outcomes, add positive accurate-link coverage, and document pause-first rollout plus Gateway-first rollback.

## Follow-up review fixes

- [x] Add `sendChatTurn` coverage proving a small real-shaped `open_page` SSE receipt keeps `targetUrl` and does not show an omission notice; prove an oversized turn keeps every activity identity and terminal state within 64 KiB.
- [x] Propagate cancellation while `getWebMode` is reading `response.json()` as `CODEX_GATEWAY_ABORTED`, preserving canceled turn/sync state and preventing Gateway requests or side effects.
- [x] Validate mode with explicit string equality or a safe membership set; reject `toString`, `constructor`, `__proto__`, missing, and other non-`legacy`/`native` response values before sending a chat request.
