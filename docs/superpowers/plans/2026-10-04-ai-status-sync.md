# AI Status Synchronization Bugfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make proactive `[[STATUS:...]]` updates persist and appear in the frontend reliably, without startup synchronization overwriting the backend's latest AI status.

**Architecture:** Keep `status` as the canonical event type because the parser, backend action handling, and NTFY notification already use it; accept the historical `ai_status_change` type only as a read-compatible alias. Persist the status value as the system-event content for status events, while status chat persistence creates only the existing status notice. Treat backend-generated `_aiStatus` as backend-owned during routine frontend config sync, and hydrate it before the initial outbound sync/render.

**Tech Stack:** Node.js 22, Express 5, browser JavaScript, Node built-in `node:test`, `vm` frontend test harness.

**Spec:** `docs/superpowers/plans/2026-09-01-proactive-message-persistence.md` plus the user-confirmed scope in this conversation: fix the `status`/`ai_status_change` contract mismatch and the startup stale-state overwrite race.

## Global Constraints

- Keep `status` as the canonical new event type; read old `ai_status_change` events for backward compatibility.
- Preserve the existing NTFY title/body behavior for status notifications.
- Keep AI status limited to the existing 15-character normalization rule.
- Do not add a Supabase schema migration; reuse `system_events.content` and `project_configs._aiStatus`.
- Do not change unrelated proactive message, TODO, diary, litter, email, or desire behavior.
- Do not deploy, push, or commit unless separately requested.

## Review Focus

- A status-only proactive reply must update `_aiStatus` and not create a normal assistant bubble; pin in the backend status-row test and frontend polling test.
- A status reply containing both prose and a marker must use the marker value as the synchronized status, not the prose; pin in the status payload test.
- Historical `ai_status_change` events must remain readable; pin in the frontend compatibility test.
- A stale local empty status must not overwrite a newer backend status during startup or chat/project selection; pin in the config-sync payload test.
- NTFY status notifications must remain static and must not expose the status text; retain the existing notification regression coverage.

### Task 1: Add the status contract seam and failing regression tests

**Files:**
- Create: `proactive-status-utils.js`
- Test: `test/proactive-status-utils.test.js`
- Modify: `test/sync-proactive.test.js`

**Interfaces:**
- `isAiStatusEventType(type: unknown): boolean` returns `true` for `status` and legacy `ai_status_change`.
- `normalizeAiStatus(value: unknown): string` trims and caps the value at 15 characters, matching current behavior.
- `getStatusEventContent({ status, message }): string` returns the normalized marker value when present, otherwise the fallback message.
- `createStatusNotice({ projectId, windowId, messageId, eventId, driveKey, createdAt, actionType, aiName }): object` returns one Supabase-compatible system chat row with the canonical status-notice copy and proactive metadata.

- [ ] **Step 1: Write failing unit tests for the status contract.**
  - Assert canonical and legacy event-type recognition.
  - Assert trimming and 15-character truncation.
  - Assert a status payload is the marker value even when a separate prose message exists.
  - Assert `createStatusNotice()` creates one system row and never an assistant row.

- [ ] **Step 2: Run the focused test and verify it fails for the expected missing-module reason.**

  Run: `node --test test/proactive-status-utils.test.js`

- [ ] **Step 3: Implement the smallest pure helper module.**

- [ ] **Step 4: Run the focused test and verify it passes.**

### Task 2: Make backend status events carry the correct semantic payload

**Files:**
- Modify: `server.js:10-32, 1019-1123, 4770-4798`
- Test: `test/proactive-status-utils.test.js`

**Interfaces:**
- `status` and `ai_status_change` are both treated as status-event types when deciding whether to create an assistant chat row and which system notice to create.
- A newly saved `status` system event stores the normalized marker value in `system_events.content`, even if the model also returned display prose.

- [ ] **Step 1: Extend the helper tests with the backend-facing status-row cases.**
  - A canonical status event produces the status notice row only.
  - A legacy `ai_status_change` event follows the same rule.
  - A normal `message` event remains covered by the existing proactive-message tests.

- [ ] **Step 2: Run the focused test and verify it fails against the current `status` handling.**

- [ ] **Step 3: Use `isAiStatusEventType`, `normalizeAiStatus`, and `createStatusNotice` in the backend.**
  - Extend the status notice/exclusion checks to include canonical `status`.
  - Use `getStatusEventContent({ status: actions.status, message: visibleMessage })` as the status event content.
  - Keep NTFY dispatch using `actionType: 'status'`, preserving the static notification copy.

- [ ] **Step 4: Run the focused backend tests and verify they pass.**

### Task 3: Consume canonical and legacy status events in the frontend

**Files:**
- Modify: `public/js/sync.js:syncProjectConfigToBackend, reconcileFromBackend, pollSystemEvents`
- Test: `test/sync-proactive.test.js`

**Interfaces:**
- `pollSystemEvents()` accepts both `status` and `ai_status_change`, writes the event content to `proj._aiStatus`, marks `_aiStatusChanged`, persists the store, and refreshes the active chat view.
- `reconcileFromBackend()` marks the status as changed only when the hydrated backend value differs from the local value, persists it, and refreshes the active view when needed.

- [ ] **Step 1: Add failing VM-harness tests.**
  - A `status` event updates `_aiStatus` and leaves the proactive message pull intact.
  - A legacy `ai_status_change` event still updates `_aiStatus`.
  - A backend config response hydrates `_aiStatus` and requests a render when it changes.

- [ ] **Step 2: Run the focused frontend tests and verify the new tests fail while existing proactive-message tests remain meaningful.**

  Run: `node --test test/sync-proactive.test.js`

- [ ] **Step 3: Implement the minimal frontend event and reconciliation changes.**
  - Match canonical and legacy event types.
  - Keep the event cursor and deduplication behavior unchanged.
  - Do not create a second synthetic status bubble; the cloud proactive-message path remains the single message source.

- [ ] **Step 4: Run the focused frontend tests and verify they pass.**

### Task 4: Remove stale frontend ownership of backend-generated AI status

**Files:**
- Modify: `public/js/sync.js:116-157`
- Modify: `public/js/app-core.js:1111-1115`
- Test: `test/sync-proactive.test.js` and a small startup-order/config-payload regression test if the existing harness supports it

**Interfaces:**
- Routine `syncProjectConfigToBackend()` does not send `_aiStatus`; explicit status updates and backend cron remain the writers of that field.
- Startup awaits `reconcileFromBackend()` before the initial routine config sync, so the first render/sync observes the backend-authoritative state.

- [ ] **Step 1: Add failing coverage proving a routine full-config sync currently includes stale `_aiStatus`, and proving startup currently fires sync before reconciliation.**

- [ ] **Step 2: Run the focused test and verify it fails against the current ordering/payload.**

- [ ] **Step 3: Remove `_aiStatus` from the routine full-config payload and await reconciliation before the initial config sync.**
  - Preserve the direct partial `_aiStatus` write from interactive chat status handling.
  - Preserve all unrelated config fields and project/chat selection behavior.

- [ ] **Step 4: Run the focused test and verify it passes.**

### Task 5: Full verification and cleanup

**Files:**
- Test: `test/*.test.js`
- Inspect: changed files and `docs/superpowers/plans/2026-10-04-ai-status-sync.md`

- [ ] **Step 1: Run focused status, proactive-message, notification, and sync tests.**

- [ ] **Step 2: Run the full suite:** `npm test`

- [ ] **Step 3: Run syntax and diff checks:** `node --check server.js`, `git diff --check`.

- [ ] **Step 4: Re-run the original red reproduction and confirm the status event now updates `_aiStatus` while the proactive message remains deduplicated.**

- [ ] **Step 5: Confirm no debug instrumentation, deployment, push, or unrelated file changes remain.**
