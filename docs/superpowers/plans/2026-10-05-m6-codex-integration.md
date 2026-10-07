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

M6A is complete for the reviewed backend and proxy scope. M6B frontend implementation, code review, offline validation, and isolated real-page acceptance are now complete for this local checkpoint. The real Gateway and production end-to-end chain have not been verified, and production console/environment configuration remains outside this checkpoint. The overall M6 effort must not be marked complete until those later scopes are addressed.

## M6B Implementation and Review Record

M6B is the separately authorized frontend and message-synchronization phase. Its implementation, review fixes, offline validation, and isolated page acceptance are complete and are included in this local checkpoint. The work did not modify `codex-gateway.js`, `vercel-render-proxy.js`, the existing Claude client/protocol, or production configuration. M6A remains the committed backend checkpoint.

### M6B architecture and contracts

- Keep `codex-code-test` (`Codex Local`, runtime `codex-gateway`) as an isolated WarmBuddy project. It reuses the existing WarmBuddy context rules without sharing Claude project data, handoff, caches, or session mappings.
- Add a dedicated `public/js/codex.js` transport/lifecycle adapter. It calls only same-origin `/api/codex/stream` and `/api/codex/sessions/:sessionId`, parses only the five named M6A events, and stores session sidecars only on the current device.
- Extract only explicit project/chat context helpers needed by Codex from `public/js/chat.js`; retain the existing Claude/ordinary request construction and parser unchanged in behavior.
- Use the existing L1/L2 round and summary rules. Exclude the current send batch before appending the current user message and quote once. Continuations send current rules/settings/dynamic snapshots but not the full Gateway-session history.
- Preflight the final UTF-8 prompt and serialized `{prompt, sessionId?}` body against the M6A byte limits. Over-limit input is a visible failure with no truncation, reset, retry, or replay.
- Use one per-chat Codex lock and generation-bound `AbortController`. A temporary session is committed only after successful completion and valid session confirmation; continuation failures retain the old session, and `UNKNOWN_SESSION` marks it invalid without replaying the prompt.
- Persist uploaded messages and turn states without session IDs. The sync protocol uses stable message IDs, dirty/upsert status updates, bounded cursor/page reads, terminal-state precedence, and exact `windowId` restoration. A separate Codex conversation-read route preserves `/api/chat-messages` as the proactive-only endpoint.

### M6B tasks

1. **Project and explicit-context seams**
   - Modify `public/js/app-core.js` to ensure the independent Codex project and expose project-scoped lookup without changing Claude defaults.
   - Modify `public/js/chat.js` only to expose explicit context/marker helpers and route Codex chats to the new adapter; old Claude/ordinary branches keep their existing request body and SSE parser.
   - Add failing frontend source/VM tests for project isolation, context scope, L1/L2/current-message de-duplication, preference clearing, and no cross-runtime handoff.

2. **Codex frontend adapter and UI lifecycle**
   - Create `public/js/codex.js` with prompt serialization, UTF-8/body preflight, named SSE parsing, session sidecar storage, lock/generation state, cancellation, temporary-session commit, delete/disconnect handling, and controlled status transitions.
   - Modify `public/index.html`, `public/js/ui.js`, and `public/js/settings.js` to load/register the module, hide invalid API settings for Codex, and expose stop/new-session/disconnect states without reusing `cancelReply`.
   - Add tests for fragmented Unicode/heartbeat/multiple messages, failure/unknown/timeout/cancel, reload and chat-switch generations, and session sidecar exclusion.

3. **Search, markers, and attachments**
   - Adapt the existing WarmBuddy search marker flow to call `/api/search` once and continue the same Codex session with bounded external-results context; do not call `/api/chat/stream`, recurse, or replay the user prompt.
   - Apply diary/memory/core/todo/email/poke/status/artifact markers only at the authorized successful final commit point, with original project/chat/generation and action dedupe. Failed, canceled, or unknown turns cannot execute actions.
   - Preserve artifact and `[[FILE:id]]` references without binary/Data URL extraction and show the reference-only limitation.
   - Add tests for search failure/cancel, multi-marker bounds, action commit points, and non-idempotent dedupe.

4. **Message synchronization and backup isolation**
   - Modify `server.js` only for a Codex-scoped conversation upload/read contract and metadata allowlist. Do not alter M6A routes or unrelated proactive semantics. Reuse the existing `chat_messages` metadata JSON; do not add a migration.
   - Modify `public/js/sync.js` to upload user/running/terminal states, re-upload dirty updates, read updates with a bounded version/cursor strategy, create missing chats by exact `windowId`, and merge terminal states without defaulting missing status to completed.
   - Modify `public/js/backup.js` and import/clear paths so Codex session sidecars and pending-disconnect records are never exported, imported, synced, or silently retried; chats and turn states remain backed up.
   - Add server contract tests and VM tests for pagination, state updates, terminal precedence, observation-device behavior, project/chat restoration, and session-field rejection.

5. **Review and validation**
   - Run focused M6B tests first, then the full repository suite, syntax/diff checks, and a loopback-only fake Gateway/search/database smoke test.
   - If the installed browser capability is available, exercise the actual page with temporary fake data: send, stream multiple messages, stop, switch chat, reload, new session, disconnect, search continuation, action dedupe, and cross-device message merge. Do not load user browser data.
   - Generate a non-secret external-review report in an independent Windows temporary directory if requested. Do not commit during implementation or review; after acceptance, a local checkpoint commit may be created under explicit user authorization. Push, deployment, and real Gateway calls remain outside this scope.

### M6B final patch status

- Implemented and reviewed: final-stage-only marker actions with per-action keys; one shared Codex/search/integration controller, generation, lock, and cancellation path; storage/sidecar cleanup; WarmBuddy L1/summary context without Codex-triggered compression or L2 replay; versioned immutable message-sync snapshots; terminal-state conflict handling and conditional server writes; continued Codex pagination; boundary-aware Codex message insertion; and visible pending-disconnect retry state.
- Added isolated regression coverage for search action boundaries, search cancellation, context selection, storage failures, invalidation, action status filtering, sync acknowledgements and races, pagination, same-turn ordering, and legacy barriers. Existing M6A, Claude, ordinary-chat, and proxy tests remain in the verification set.
- The available validation includes VM/module tests, loopback HTTP fake-Gateway smoke coverage, and isolated real `public/index.html` interaction evidence using a local fake service and synthetic browser data. No user browser storage, real Gateway, Supabase, or production API was used.
- Implementation, code review, offline validation, and isolated page acceptance are complete for this patch. Real Gateway/production end-to-end validation, production secret configuration, deployment, and push are not complete or authorized. The overall M6 effort must not be marked complete until those later scopes are separately accepted.

### M6B final repair pass

- Added per-session-key sidecar write serialization so a set already in flight is followed by an invalidating remove; newer mappings are not removed by an unconditional stale cleanup. invalidateAll, new-session, disconnect, and deleted-chat/project preservation use the same coordination path.
- Enforced one page-level Codex turn lock across initial generation, application search, same-session integration, and final marker actions. Cross-chat sends return controlled BUSY; old-finally cleanup is ownership- and original-chat-bound.
- Deferred Codex dynamic snapshot mutation until request-body preflight has accepted the prompt. New sessions force the current dynamic snapshot; continuation injection keeps the existing cadence.
- Added terminal-content version advancement after marker cleanup, original project/chat action context, explicit action outcomes, project-scoped TODO synchronization, and Codex email handling that does not consult the active ordinary-chat API key.
- Preserved multiple device-local pending disconnect records, added a visible list entry independent of the active/deleted chat, and treated not_connected as no remote deletion confirmation. Manual pending processing does not become background retry.
- Added race regressions for sidecar writes, page locks and typing cleanup, dynamic snapshot acceptance, post-upload marker cleanup, original-context email/TODO actions, pending disconnect preservation, and deleted-chat pending mapping. The existing sort/barrier patch remains unchanged.

### M6B session-target and scope repair pass

- Bound every disconnect operation to the explicitly selected session ID. Pending records use their own source key, while active disconnect reads only the active sidecar; no operation falls back from one record type to another.
- Added per-session pending-disconnect keys with legacy-key parsing, target-conditional cleanup after success or `UNKNOWN_SESSION`, and target-conditional failure preservation. New active or pending mappings survive delayed responses, and multiple pending mappings remain independently processable.
- Split Codex invalidation into chat- and project-scoped operations. Deleting one chat no longer clears other chat sidecars or requests; project deletion is limited to that project, and pending preservation precedes invalidation.
- Added regressions for pending A versus active B, delayed delete/unknown responses followed by a new B session, stale failure versus a newer pending record, multiple pending records in one chat, and deleting chat A while chat B remains active. Existing cancellation, sorting, synchronization, and M6A regressions remain in the verification set.

### M6B async-context and deletion-order repair pass

- `disconnectActiveSession` and `startNewActiveSession` capture project/chat/key context before their first await; later storage, DELETE, cleanup, state reset, and operation feedback remain bound to that original context even if the UI switches chats.
- Chat/project deletion now cancels and invalidates the affected Codex requests before awaiting pending-sidecar preservation. Sidecar preservation and cleanup then run in the coordination queue; save/cleanup failure aborts deletion with a controlled notice instead of silently losing a mapping.
- Added regressions for switched-chat disconnect success/failure, switched-chat start-new-session state, stale Codex action delivery while pending preservation is delayed, and project-wide invalidation before preservation. Unrelated chat/session protections remain covered.
