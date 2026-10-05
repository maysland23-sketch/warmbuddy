# M6A Codex Gateway Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an independent server-side Codex Gateway adapter and repair Vercel response-side cancellation propagation without changing the frontend or existing Claude paths.

**Architecture:** Keep `claude-code-gateway.js`, `/api/agent/stream`, and `/api/chat/stream` unchanged. Add `codex-gateway.js` with strict request/SSE/session handling, expose it through dedicated Render routes, and pass the existing Render proxy secret boundary unchanged. Add only the Vercel proxy response-close abort hook needed for cancellation.

**Tech Stack:** Node.js 22, CommonJS, Express 5, native `fetch`, Web Streams, Node test runner, loopback HTTP fixtures.

**Spec:** User-provided M6A implementation requirements in the current task.

## Global Constraints

- Do not modify frontend code or old Claude client/routes.
- Codex Gateway token and URL are server-only; never read `.env` or real credentials.
- Gateway POST body contains only `prompt` and optional `sessionId`.
- `prompt` is nonblank, NUL-free, and at most 32768 UTF-8 bytes; serialized body is at most 65536 bytes.
- Only `completion.status=completed` is success; no retry, replay, fallback, or automatic session replacement.
- Gateway execution limit remains 120 seconds; Render outer timeout defaults to 150000 ms.
- During implementation, review, and offline validation, do not commit, push, or deploy. After M6A acceptance, the user may authorize a local checkpoint commit. Push, deployment, production secret configuration, and real remote calls remain prohibited unless separately authorized.

## Review Focus

- UTF-8 byte boundaries must not split validation semantics or allow oversized JSON bodies.
- SSE events can be split across UTF-8 chunks, lines, and event boundaries.
- Multiple complete `message` events must be forwarded in order before completion.
- Client cancellation must abort both upstream fetch and response consumption, while normal `res.end` must not abort.
- Upstream controlled errors and raw bodies must not leak credentials, URLs, private IDs, stderr, stacks, or raw response text.

### Task 1: Lock the Codex adapter contract with failing tests

**Files:**
- Create: `test/codex-gateway.test.js`
- Create: `test/codex-stream-route.test.js`
- Modify: `test/vercel-render-proxy.test.js`

Write tests first for validation, exact request body, named SSE parsing, completion semantics, no replay, delete behavior, route isolation, and response-side proxy cancellation. Run the focused tests and confirm they fail for missing implementation or missing abort behavior.

### Task 2: Implement the independent Codex client

**Files:**
- Create: `codex-gateway.js`

Implement injected `fetchImpl`/clock seams, strict HTTPS-or-explicit-loopback URL validation, server-only Bearer injection, bounded request serialization, strict five-event SSE parsing, 150000 ms outer timeout, and abort-safe cleanup. Preserve the original session on continuation failure and never retry.

### Task 3: Add isolated Render routes and configuration names

**Files:**
- Modify: `server.js`
- Modify: `.env.example`

Add `/api/codex/stream` and `/api/codex/sessions/:sessionId` behind the existing API guard. Map only a controlled allowlist of status/error codes, keep normal assistant text unchanged, and do not alter Claude routes. Add placeholder `CODEX_GATEWAY_URL`, `CODEX_GATEWAY_TOKEN`, and bounded `CODEX_GATEWAY_TIMEOUT_MS` documentation only.

### Task 4: Repair Vercel response-side cancellation

**Files:**
- Modify: `vercel-render-proxy.js`

Abort the Render fetch when the client response closes before normal completion, keep normal `res.end` successful, and remove all listeners in every path. Preserve existing header filtering, streaming pipeline, body limit, and error behavior.

### Task 5: Verify and smoke test (M6A complete)

Run the focused tests, then the full existing suite, then an in-process loopback Gateway/Render HTTP smoke test covering stream, continuation, delete, cancel, failure, and no replay. Stop and clean all temporary servers in `finally` blocks. Review the final diff for frontend/Claude changes, secrets, and unrelated edits. During implementation and review, do not commit; after acceptance, the user may authorize the local M6A checkpoint commit.

The M6A implementation and review have now completed. The accepted scope includes the independent Codex backend adapter, strict five-event SSE handling, session deletion, client cancellation propagation through Render and Vercel, controlled error mapping and payload redaction, cumulative resource bounds, and their offline regression coverage.

Recorded validation results:

- Codex client and Render route focused tests: 26/26 passed.
- Full repository test suite: 168/168 passed.
- Loopback fake-Gateway smoke test: 1/1 passed.

The user has authorized creating the local M6A checkpoint commit after these checks. This authorization does not include push, deployment, production secret configuration, or real remote Gateway calls.

## M6A Boundary and Remaining Work

M6A is complete for the reviewed backend and proxy scope. M6B frontend work has not been implemented. The real Gateway and production end-to-end chain have not been verified, and production console/environment configuration remains outside this checkpoint. The overall M6 effort must not be marked complete until those later scopes are addressed.
