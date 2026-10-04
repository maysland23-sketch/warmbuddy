# Diary Card Author Side Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI-authored diary cards render on the AI side of Chat and user-authored diary cards render on the user side.

**Architecture:** Keep `diary.author` as the source of truth and centralize its conversion to the existing Chat roles (`ai` or `user`). Use that conversion both when pending deliveries become chat messages and when persisted `shared_diary` messages are rendered, so old messages with a stale `role: 'user'` are corrected at display time. Leave delivery persistence, diary visibility, and prompt injection behavior unchanged.

**Tech Stack:** Browser JavaScript modules, Node.js built-in test runner, `vm`-based frontend module tests.

**Spec:** N/A — user-confirmed bug report in the current task.

## Global Constraints

- `diary.author === 'ai'` maps to Chat role `ai`; every other author value maps to Chat role `user` for backward-safe fallback.
- AI and user diary cards must preserve their existing card content, click behavior, delivery consumption, and visibility rules.
- The fix must cover both newly created pending-delivery messages and already persisted `shared_diary` messages.
- Do not change backend diary schemas, delivery APIs, or the shared-diary prompt injection contract in this fix.

## Review Focus

- A newly delivered AI diary must create and render an AI-side message; pin this in the renderer regression test.
- A newly delivered user diary must remain user-side; pin this in the same test.
- A previously persisted AI diary card whose message role is still `user` must render AI-side; pin this as the compatibility case.
- Unknown or missing author values must fall back to user-side rendering rather than producing invalid CSS/classes; pin this as a fallback case.
- Existing non-diary chat messages must keep their current rendering; run the complete test suite after the focused tests.

### Task 1: Add a red regression test for diary-card side selection

**Files:**
- Create: `test/chat-diary-card.test.js`
- Test: `test/chat-diary-card.test.js`

**Interfaces:**
- Consumes: `ChatModule.renderChatMessages()` from `public/js/chat.js`.
- Produces: A deterministic test seam that asserts both the generated `chat.messages` role and rendered HTML classes.

- [x] **Step 1: Write the failing tests**

  Load the real `public/js/chat.js` through `vm`, provide the minimal `AppCore`/DOM stubs needed by `renderChatMessages`, and cover:

  - pending `author: 'ai'` diary → message role `ai`, HTML contains `chat-row ai` and `chat-bubble ai`;
  - pending `author: 'user'` diary → message role `user`, HTML contains `chat-row user` and `chat-bubble user`;
  - existing `shared_diary` message with `role: 'user'` but `sharedDiary.author: 'ai'` → HTML renders AI-side;
  - missing/unknown author → user-side fallback.

- [x] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/chat-diary-card.test.js`

  Expected: FAIL because the current implementation always creates and renders shared diary cards as user-side.

### Task 2: Derive Chat card role from diary author

**Files:**
- Modify: `public/js/chat.js:471-497, 859-866`
- Test: `test/chat-diary-card.test.js`

**Interfaces:**
- Consumes: A diary object with `author` and a `shared_diary` Chat message containing `sharedDiary`.
- Produces: A single internal author-to-role mapping used by pending-card creation and shared-card rendering.

- [x] **Step 1: Add the smallest shared role helper**

  Add an internal helper near the existing diary helpers, with behavior equivalent to:

  `diary.author === 'ai' ? 'ai' : 'user'`

  Use it in `ensureSharedDiaryCards` instead of the hardcoded `role: 'user'`.

- [x] **Step 2: Make the shared-diary renderer use the diary-derived role**

  In the `contentType === 'shared_diary'` branch, derive the side from `m.sharedDiary`, then use that role consistently for `chat-row`, avatar, bubble, and avatar text. Keep the existing card markup and `openSharedDiary` action unchanged.

  This display-time derivation is required for persisted cards created before the fix; it must not depend only on the message's stored `role`.

- [x] **Step 3: Run the focused regression test**

  Run: `node --test test/chat-diary-card.test.js`

  Expected: PASS for AI, user, legacy persisted AI, and fallback cases.

### Task 3: Verify the complete regression surface

**Files:**
- Modify: None unless the focused test reveals an existing contract mismatch.

**Interfaces:**
- Consumes: The corrected `ChatModule` behavior and the repository test suite.
- Produces: Evidence that diary-side correction does not regress existing chat, sync, or diary utility behavior.

- [x] **Step 1: Run all tests**

  Run: `npm test`

  Expected: All existing tests and the new diary-card regression tests pass.

- [x] **Step 2: Re-run the minimal end-to-end renderer check**

  Run the in-memory `vm` harness for an AI diary delivery and confirm the output contains `chat-row ai`, then repeat for a user diary and confirm `chat-row user`.

- [x] **Step 3: Inspect the final diff**

  Confirm only the focused frontend role mapping and regression test changed; no debug instrumentation or unrelated refactoring remains.
