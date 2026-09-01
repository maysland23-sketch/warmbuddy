# Proactive Message Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist every chat-visible proactive action when the backend triggers it, restore it from Supabase when the frontend opens, and preserve the backend trigger timestamp.

**Architecture:** `system_events` remains the durable proactive-event/audit stream. The backend also writes chat-visible proactive records to `chat_messages` using stable IDs and the event trigger timestamp. The frontend pulls and idempotently merges those records; it no longer uploads synthetic proactive bubbles after page load.

**Tech Stack:** Node.js 22, Express 5, Supabase JS, browser JavaScript, Node built-in `node:test`.

**Spec:** The confirmed design is recorded in the conversation: all chat-visible proactive actions, last active chat per project, `chat_messages` as chat source, and idempotent historical backfill without new LLM calls.

## Global Constraints

- Do not call the LLM again during historical backfill.
- Use one backend-generated trigger timestamp for all records belonging to a proactive trigger.
- Use stable IDs and idempotent upserts to prevent duplicate bubbles.
- Preserve `system_events` for desire-state and business-event synchronization.
- Do not change unrelated chat, memory, diary, or notification behavior.

### Task 1: Add tested proactive message normalization and merge helpers

**Files:**
- Create: `proactive-message-utils.js`
- Create: `test/proactive-message-utils.test.js`
- Modify: `package.json`

**Interfaces:**
- `createProactiveChatMessage(input)` returns a Supabase-compatible row with `message_id`, `project_id`, `window_id`, `role`, `content`, `created_at`, and proactive metadata.
- `mergeProactiveMessages(existingMessages, cloudRows)` returns messages deduplicated by stable ID and sorted by canonical `createdAt`.

- [ ] **Step 1: Write failing tests** for trigger timestamp preservation, stable-ID deduplication, and chronological merge.
- [ ] **Step 2: Run** `node --test test/proactive-message-utils.test.js` and verify it fails because the helper module is missing.
- [ ] **Step 3: Implement** the smallest pure helper module.
- [ ] **Step 4: Run** the focused test and verify it passes.

### Task 2: Persist proactive chat messages in the backend

**Files:**
- Modify: `server.js:2489-2540`, `server.js:3070-3160`, `server.js:3739-4130`
- No schema change required; the existing `chat_messages.metadata` JSONB field carries proactive metadata.

**Interfaces:**
- Add `GET /api/chat-messages?projectId=&windowId=&since=` returning canonical cloud messages.
- Add backend helper `saveProactiveChatMessage(row)` using an idempotent upsert.
- Add backend helper `backfillProactiveChatMessages(projectId, windowId)` that derives stable IDs from existing event IDs and never invokes an LLM.

- [ ] **Step 1: Add failing backend helper tests** for `message`, `todo`, and `todo_wake` persistence using the same `created_at` as the trigger.
- [ ] **Step 2: Run focused tests and verify the expected failure.**
- [ ] **Step 3: Capture `triggeredAt` before the proactive LLM call and use it for event, business, and chat records.**
- [ ] **Step 4: Persist chat-visible assistant/system rows for desire and TODO wake paths, retaining business-table writes.**
- [ ] **Step 5: Add the GET endpoint and idempotent event-to-message backfill.**
- [ ] **Step 6: Run focused backend tests and verify they pass.**

### Task 3: Make target chat identity durable

**Files:**
- Modify: `public/js/sync.js:116-158`, `public/js/chat.js:140-160`, `public/js/app-core.js:940-946`

**Interfaces:**
- Configuration sync includes `_chatId` whenever the active project/chat is known.

- [ ] **Step 1: Add a failing test or static assertion for startup and chat-selection `_chatId` sync.**
- [ ] **Step 2: Verify it fails against the current startup/selection flow.**
- [ ] **Step 3: Include `_chatId` in startup, project-selection, and chat-selection sync paths, with deterministic last-chat fallback.**
- [ ] **Step 4: Verify the focused test/static check passes.**

### Task 4: Pull and merge cloud proactive messages in the frontend

**Files:**
- Modify: `public/js/sync.js:345-510`
- Modify: `public/js/chat.js:789-930`

**Interfaces:**
- Add `pullChatMessages(projectId)` to fetch cloud rows and merge them into the relevant local chat.
- Store `createdAt` on restored messages; derive display `date`/`time` from it.
- Existing `system_events` processing updates desire/business state but does not create duplicate AI bubbles.

- [ ] **Step 1: Add failing frontend merge tests** for closed-page recovery, stable-ID dedupe, trigger-time display, and insertion order.
- [ ] **Step 2: Run them and verify they fail.**
- [ ] **Step 3: Implement pull, merge, and cursor advancement using the maximum returned server timestamp rather than local current time.**
- [ ] **Step 4: Remove the old synthetic proactive-bubble path or gate it to legacy events that have no cloud message, using the same stable ID.**
- [ ] **Step 5: Run focused frontend tests and verify they pass.**

### Task 5: Repair legacy records and remove current-time overwrite

**Files:**
- Modify: `public/js/sync.js:160-220`
- Modify: `server.js:2489-2540`
- Modify: `test/proactive-message-utils.test.js`

- [ ] **Step 1: Add a regression test proving a restored proactive message is not re-uploaded with the page time.**
- [ ] **Step 2: Verify it fails against the current sync implementation.**
- [ ] **Step 3: Make normal sync honor an existing `createdAt`/`created_at`, while cloud proactive messages are marked synced immediately after pull.**
- [ ] **Step 4: Add historical event backfill coverage and verify stable IDs prevent duplicates.**
- [ ] **Step 5: Run all tests.**

### Task 6: Full verification

**Files:**
- Test: `test/*.test.js`

- [ ] **Step 1: Run** `node --test test/*.test.js`.
- [ ] **Step 2: Run** `node --check server.js`.
- [ ] **Step 3: Run** `git diff --check`.
- [ ] **Step 4: Inspect the final diff and verify only the approved files changed.**
- [ ] **Step 5: Report exact test output and any Supabase SQL migration requirement.**
