# Custom Prompt Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add locally persisted custom prompt definitions with per-chat enablement and deterministic next-round/every-X-round injection into all normal AI requests.

**Architecture:** Add a focused `CustomPromptModule` for definitions, window state, normalization, scheduling, and Settings rendering. Keep definitions and per-chat counters inside the existing `AppCore` store, inject only into the current request payload, and merge all provider system messages server-side for Anthropic compatibility.

**Tech Stack:** Vanilla browser JavaScript, existing AppCore/localForage/localStorage persistence, existing modal and Settings UI, Express, Node.js built-in test runner.

**Spec:** `docs/superpowers/specs/2026-10-04-custom-prompts-design.md`

## Global Constraints

- Default frequency is every 5 AI requests; minimum frequency is 1.
- Each prompt body is limited to 3000 Unicode characters.
- Enabled prompt bodies in one chat window are limited to 6000 Unicode characters total.
- Definitions are shared across projects and chat windows; enablement and counters are per chat window and default off.
- Local commands do not advance the custom-prompt round; one batch AI request advances it once.
- Prompt blocks are request-only system context and must never be stored in `chat.messages`.
- Prompt content remains local until enabled, then is sent to the configured model service with the request.
- Preserve line breaks and raw prompt content; escape content before HTML rendering.
- Add no new dependency and no new backend prompt persistence API.
- New Settings UI must not add emoji.

## Review Focus

- Malformed or oversized persisted prompt data must be isolated and repaired without discarding the rest of the store; test in Task 1.
- Unicode, leading/trailing whitespace, and multiline content must validate and preserve correctly; test in Task 1.
- Multiple chat windows must not share enablement or counters; test in Task 1 and Task 2.
- Failed outgoing requests, local commands, and batched drafts must follow the exact round semantics; test in Task 4.
- Multiple system messages must survive Anthropic conversion and the search follow-up must reuse the same prompt block; test in Task 4 and Task 5.

---

### Task 1: Build the custom prompt state and scheduling module

**Files:**
- Create: `public/js/custom-prompts.js`
- Test: `test/custom-prompts.test.js`

**Interfaces:**
- Consumes: `AppCore.getStore()`, `AppCore.gid()`, `AppCore.saveStore()`, `AppCore.escapeHtml()`, `UIModule.toast()` when available.
- Produces: `CustomPromptModule` registered as `customPrompts` with `init()`, `getDefinitions()`, `renderSettings()`, `showEditor(promptId)`, `saveEditor()`, `toggleForActiveChat(promptId, enabled)`, `deleteDefinition(promptId)`, `beginAiRound(chat)`, and `normalizeStore()`.

- [ ] **Step 1: Write failing scheduler and normalization tests**

  Add VM-based tests with a minimal `AppCore`/`UIModule` stub. Pin these behaviors: default interval 5; invalid records are dropped or repaired; body length is capped at 3000 Unicode characters; empty trimmed content is rejected; enabling schedules the next round; round 1 and then `1 + interval * n` are injected; different chats are isolated; disabling stops injection; changing interval resets to the next round; editing content does not reset the schedule; aggregate enabled content over 6000 characters is rejected; and injected content keeps newlines and does not appear in chat messages.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/custom-prompts.test.js`

  Expected: FAIL because `public/js/custom-prompts.js` and its public interface do not exist yet.

- [ ] **Step 3: Implement the module in `public/js/custom-prompts.js`**

  Keep normalization and scheduling behind the module interface. Store definitions in `store.customPrompts`, store `chat.customPromptRound` and `chat.customPromptStates`, compare lengths with Unicode code-point counts, and make `beginAiRound(chat)` increment exactly once before the outgoing fetch attempt. Build stable wrappers for the API context in definition order while leaving each body unchanged; escape only when rendering HTML.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test test/custom-prompts.test.js`

  Expected: PASS for all custom prompt state, scheduling, validation, and formatting tests.

- [ ] **Step 5: Commit the focused module and tests**

  Run: `git add public/js/custom-prompts.js test/custom-prompts.test.js && git commit -m "feat: add custom prompt scheduling module"`

### Task 2: Integrate persistence, migrations, and new-window defaults

**Files:**
- Modify: `public/js/app-core.js` (store defaults and `migrateStoreAsync()`)
- Modify: `public/js/chat.js` (all chat construction paths: normal new chat, explicit new chat, draft-created chat)
- Test: `test/frontend-custom-prompts.test.js`

**Interfaces:**
- Consumes: `CustomPromptModule.normalizeStore()` and the existing `AppCore` store lifecycle.
- Produces: every loaded store has normalized `customPrompts`; every chat has an independent empty prompt-state map and zero prompt round counter.

- [ ] **Step 1: Add failing persistence contract tests**

  Assert that the frontend source initializes `customPrompts`, invokes normalization during store migration, and creates `customPromptRound: 0` plus `customPromptStates: {}` in every chat creation path. Assert that no new-chat path copies another chat's prompt enablement.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/frontend-custom-prompts.test.js`

  Expected: FAIL on the missing store fields and chat defaults.

- [ ] **Step 3: Implement migration and defaults**

  Add a safe migration call after the store is loaded and before normal modules use the data. Remove prompt states whose IDs no longer exist, preserve the rest of the store on malformed prompt data, and add empty per-chat state to all existing and newly created chats. Keep prompt data inside `warmbuddy-store` so BackupModule needs no separate key.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test test/frontend-custom-prompts.test.js`

  Expected: PASS, including all chat creation paths.

- [ ] **Step 5: Commit the persistence integration**

  Run: `git add public/js/app-core.js public/js/chat.js test/frontend-custom-prompts.test.js && git commit -m "feat: persist custom prompt window state"`

### Task 3: Add Settings UI and CRUD interactions

**Files:**
- Modify: `public/index.html` (custom prompt Settings group and script order)
- Modify: `public/js/settings.js` (refresh hook)
- Modify: `public/js/ui.js` (action delegation)
- Modify: `public/js/custom-prompts.js` (modal/list rendering implementation)
- Test: `test/frontend-custom-prompts.test.js`

**Interfaces:**
- Consumes: `CustomPromptModule` CRUD and active-chat state methods from Task 1; existing `UIModule.showModal()` and `AppCore.escapeHtml()`.
- Produces: a Settings module where users can create, edit, delete, enable, and disable prompts for the current chat window.

- [ ] **Step 1: Add failing UI contract tests**

  Assert that the Settings markup contains the custom prompt container and add button, that the script loads `custom-prompts.js` before `settings.js`, and that `ui.js` dispatches create/save/edit/delete/toggle actions. Assert that the source uses escaping for prompt text and exposes the 3000-character and minimum-frequency constraints.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/frontend-custom-prompts.test.js`

  Expected: FAIL on the missing markup, actions, and rendering hooks.

- [ ] **Step 3: Implement the Settings experience**

  Add the simple list group in the existing Settings style, a short privacy note, and a modal with optional title, required multiline content, and numeric interval. Render title/content previews with `AppCore.escapeHtml()`. Re-render after every CRUD or toggle operation; reject empty content, invalid frequency, and aggregate enabled content over 6000 characters with a clear toast. Use no emoji in new UI copy.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test test/frontend-custom-prompts.test.js`

  Expected: PASS for markup, action wiring, validation, escaping, and script order.

- [ ] **Step 5: Commit the Settings UI**

  Run: `git add public/index.html public/js/settings.js public/js/ui.js public/js/custom-prompts.js test/frontend-custom-prompts.test.js && git commit -m "feat: add custom prompt Settings UI"`

### Task 4: Inject prompts into chat requests without polluting history

**Files:**
- Modify: `public/js/chat.js` (`triggerAIResponse()` and web-search follow-up request construction)
- Modify: `public/js/custom-prompts.js` only if the integration needs a narrow helper adjustment
- Test: `test/frontend-custom-prompts.test.js`

**Interfaces:**
- Consumes: `CustomPromptModule.beginAiRound(chat)` from Task 1.
- Produces: every normal AI request receives the current round's custom system context, while local commands and the search follow-up do not create duplicate rounds.

- [ ] **Step 1: Add failing chat integration assertions**

  Assert that `triggerAIResponse()` calls `beginAiRound()` once before its initial fetch, appends the returned content to `apiMessages`, and carries the same content into `apiMessages2` for web search. Assert that a simulated fetch rejection does not roll back the already-counted outgoing round. Assert that custom prompt text is not pushed into `chat.messages` and that the request body continues to use the Agent Gateway branch without provider credentials.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/frontend-custom-prompts.test.js`

  Expected: FAIL until chat request construction is wired.

- [ ] **Step 3: Implement the request integration**

  Call `beginAiRound(chat)` exactly once per `triggerAIResponse()` invocation, before the first request is sent. Append the returned system message after the existing dynamic context and reuse the same returned string for the search second pass. Do not alter `chat.messages`, `groupMessagesIntoRounds()`, or the existing sliding-window selection.

- [ ] **Step 4: Run focused and existing frontend tests**

  Run: `node --test test/custom-prompts.test.js test/frontend-custom-prompts.test.js test/chat-split.test.js`

  Expected: PASS with no regression in sentence splitting or existing frontend contracts.

- [ ] **Step 5: Commit chat integration**

  Run: `git add public/js/chat.js public/js/custom-prompts.js test/frontend-custom-prompts.test.js && git commit -m "feat: inject custom prompts into chat context"`

### Task 5: Preserve all system context for Anthropic requests

**Files:**
- Modify: `server.js` (`buildRequestBody()` Anthropic branch)
- Test: `test/chat-system-context.test.js`

**Interfaces:**
- Consumes: the existing `/api/chat` request route and provider resolution.
- Produces: Anthropic request bodies whose `system` field contains every incoming system message in order, separated by blank lines.

- [ ] **Step 1: Add a failing provider regression test**

  Start a local mock upstream endpoint and the Express app, send `/api/chat` a request with two system messages and one user message using an Anthropic-shaped endpoint, then capture the upstream JSON. Assert that `body.system` contains both system messages in order and that the user message remains in `body.messages`.

- [ ] **Step 2: Run the focused test to verify it fails**

  Run: `node --test test/chat-system-context.test.js`

  Expected: FAIL because the current implementation only uses the first system message.

- [ ] **Step 3: Implement system-message merging**

  Replace the first-system lookup with ordered filtering, string normalization, empty-value removal, and `join('\n\n')`. Leave OpenAI-compatible message mapping and tool-call fields unchanged.

- [ ] **Step 4: Run the focused test to verify it passes**

  Run: `node --test test/chat-system-context.test.js`

  Expected: PASS for multiple system messages, empty system content, and ordinary user/assistant message preservation.

- [ ] **Step 5: Commit the provider fix**

  Run: `git add server.js test/chat-system-context.test.js && git commit -m "fix: preserve multiple system prompts for Anthropic"`

### Task 6: Run the full verification and handoff review

**Files:**
- Modify: only files required to fix verification failures from Tasks 1–5.
- Test: all existing `test/*.test.js` plus the new focused tests.

**Interfaces:**
- Consumes: the complete implementation from Tasks 1–5.
- Produces: a verified implementation with no unreviewed diff errors and documented behavior matching the approved spec.

- [ ] **Step 1: Run all tests**

  Run: `npm test`

  Expected: all existing tests and new custom-prompt tests pass with zero failures.

- [ ] **Step 2: Run repository diff checks**

  Run: `git diff --check`

  Expected: no whitespace errors.

- [ ] **Step 3: Perform the manual browser checklist**

  Verify in Settings: create a multiline prompt, see it disabled in every chat, enable it in one chat, observe injection on the next AI request, verify the next interval, disable it, edit it, delete it, refresh, export/import, and test the 6000-character enable guard. Verify the prompt never appears as a visible chat bubble.

- [ ] **Step 4: Inspect the final diff against the spec**

  Confirm no backend persistence API, browser-Tab sync, extra dependency, or unrelated refactor was introduced; confirm the new UI contains no emoji; confirm all acceptance criteria in the design spec have an owning code path and test.

- [ ] **Step 5: Report the final verification results**

  Include changed files, test command output summary, any environment-limited manual checks, and the final commit list.
