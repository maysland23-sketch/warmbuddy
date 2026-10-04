# Chat Date/Time Display and Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一 chat 消息的日期时间数据与排序规则，使非当天用户/AI气泡都显示日期，每天的日期标题位于当天第一条可见消息（包括系统提示语）之前，并保证本地与云端系统提示语按实际发生时间显示。

**Architecture:** 新增一个纯数据层 `ChatTimeModule`，负责生成、解析和稳定排序 chat 消息时间。所有新产生的 chat-visible 消息写入 `createdAt`、本地 `date`（`YYYY-MM-DD`）和 `time`（`HH:mm`）；渲染层从统一时间信息生成日期标题和气泡时间，云端合并层使用同一排序函数。旧的 `dateDivider` 不再生成，渲染时兼容跳过。

**Tech Stack:** 原生浏览器 JavaScript、现有 `AppCore` 模块注册机制、Node.js `node:test` + `vm` 测试夹具；不新增运行时依赖或后端 schema。

**Spec:** 用户在当前对话中确认的三个 chat 日期时间问题及已确认的根因定位。

## Global Constraints

- 所有日期和时间均使用前端当前本地时区。
- 新消息必须同时具备 `createdAt` ISO 字符串、`date` 格式 `YYYY-MM-DD`、`time` 格式 `HH:mm`。
- 日期标题必须位于该日期第一条可见消息之前，系统提示语不能被排除在日期和时间间隔计算之外。
- 非当天气泡的显示格式为 `MM-DD HH:mm`，用户和 AI 使用相同规则。
- 消息排序按完整时间戳升序，完全相同的时间保持原数组顺序。
- 不修改后端 API 或数据库 schema；无法从旧数据恢复的纯 `HH:mm` 历史消息不得伪造一个确定的历史日期。

## Review Focus

- 第一条消息是系统提示语时，日期标题仍必须位于其上方；由 Task 3 的 `renders date header before a first system message` 覆盖。
- 同一天同时存在用户、AI、系统提示语时，日期只显示一次且系统提示语参与相邻时间计算；由 Task 3 的 mixed-role timeline 测试覆盖。
- 非当天用户消息走批量草稿发送路径时，也必须显示日期；由 Task 2/3 的 user bubble timestamp 测试覆盖。
- 本地较晚系统提示语先写入、云端较早系统提示语后拉取时，最终顺序必须按时间纠正；由 Task 4 的 local/cloud merge 测试覆盖。
- 旧 `dateDivider` 和缺少完整时间字段的历史消息不能破坏渲染；由 Task 3 的 legacy compatibility 测试覆盖。

### Task 1: Add the shared chat timestamp contract

**Files:**
- Create: `public/js/chat-time.js`
- Modify: `public/index.html:1200-1210` to load the module before `sync.js` and `chat.js`
- Test: `test/chat-date-time.test.js`

**Interfaces:**
- Produces `ChatTimeModule.createMessage(fields, timestamp)` returning a message object with `createdAt`, `date`, and `time` filled from the supplied `Date`/ISO timestamp while preserving all caller fields.
- Produces `ChatTimeModule.getTimeInfo(message, fallbackDate)` returning `{ createdAt, date, time, sortValue }` for valid timestamps, or `null` when the message has no recoverable date/time; `fallbackDate` may resolve a legacy same-day `HH:mm` message only when the caller explicitly supplies it.
- Produces `ChatTimeModule.sortMessages(messages, fallbackDate)` returning a new, stably sorted array using `sortValue`; valid timestamps are compared chronologically and equal timestamps retain source order, leaving the caller's input array untouched until it assigns the result.

- [ ] **Step 1: Write failing tests**

  Add tests for: generated local parts from a fixed timestamp; preference for `createdAt` over separate fields; parsing `date + time`; optional same-day fallback for legacy `HH:mm`; stable tie ordering; and chronological ordering of a 20:00 cloud system message before a 21:00 local system message.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/chat-date-time.test.js`

  Expected: FAIL because `public/js/chat-time.js` does not yet exist.

- [ ] **Step 3: Implement `ChatTimeModule`**

  Keep the module pure except for `AppCore.register('chatTime', ChatTimeModule)`. Normalize timestamps with local calendar components, retain caller-provided `createdAt` when valid, and use original array indices as the stable tie-breaker.

- [ ] **Step 4: Load the module before consumers**

  Add the script tag before `sync.js` and `chat.js`; do not alter API payload formats.

- [ ] **Step 5: Run the focused test and verify it passes**

  Run: `node --test test/chat-date-time.test.js`

  Expected: PASS for all timestamp contract cases.

### Task 2: Make all active chat-visible message producers timestamped

**Files:**
- Modify: `public/js/chat.js:220-250, 455-503, 1860-1910, 2090-2460, 2630-2950`
- Modify: `public/js/litterbox.js:160-225`
- Modify: `public/js/memory.js:1140-1155`
- Modify: `public/index.html:2310-2325` for the retained compatibility path
- Test: `test/chat-date-time.test.js`

**Interfaces:**
- Consumes `ChatTimeModule.createMessage(fields, timestamp)` from Task 1.
- Every chat-visible user, AI, and system message created by these paths receives one captured creation timestamp; async response completion time must not replace the timestamp captured for the displayed event.

- [ ] **Step 1: Extend the failing tests**

  Assert that the batch draft user path, normal user path, AI response paths, poke/status/diary/todo/core-overview notices, litterbox notices, memory notices, and compatibility litterbox path all produce `createdAt`, `date`, and `time`.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/chat-date-time.test.js`

  Expected: FAIL for at least the batch draft user message and local system-message cases because current literals only contain `time` or omit `date`.

- [ ] **Step 3: Route chat-visible literals through the timestamp helper**

  Capture a `Date`/ISO timestamp at the event or message creation point, wrap the visible message object with `ChatTimeModule.createMessage`, and preserve existing fields such as `contentType`, `_proactive`, `_toolCalls`, `replyTo`, and IDs. Leave API-only `{ role: 'system', content: ... }` request messages unchanged.

- [ ] **Step 4: Remove the delayed runtime `dateDivider` insertion**

  Stop appending `contentType: 'dateDivider'` after rendering the first user message. Retain `lastActiveDate` only for backward-compatible store shape unless the implementation proves it unused everywhere; do not create new divider records.

- [ ] **Step 5: Run the focused test and verify it passes**

  Run: `node --test test/chat-date-time.test.js`

  Expected: PASS for all active producer timestamp assertions.

### Task 3: Rebuild chat timeline rendering around canonical time

**Files:**
- Modify: `public/js/chat.js:809-950`
- Test: `test/chat-date-time.test.js`

**Interfaces:**
- Consumes `ChatTimeModule.getTimeInfo` from Task 1.
- `renderChatMessages()` derives date separators from the visible message sequence, not from persisted divider messages.

- [ ] **Step 1: Add failing render assertions**

  Using the existing VM harness style, assert that: a non-today user and AI bubble both show `MM-DD HH:mm`; a first system message is preceded by its date separator; mixed user/system/AI messages produce one separator for the date; system messages participate in gap timing; and legacy `dateDivider` records do not render as ordinary system prompts.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/chat-date-time.test.js`

  Expected: FAIL on the current role exclusions, `m.time`-only date detection, user timestamp omission, and legacy divider placement.

- [ ] **Step 3: Implement canonical rendering**

  Filter legacy `contentType === 'dateDivider'` records from the rendered list, resolve each message through `getTimeInfo`, insert a separator before the first message whose date differs from the previous visible message, and use one shared bubble-time formatter for user and AI. Track time gaps using canonical timestamps and include system messages in the previous-message state.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `node --test test/chat-date-time.test.js`

  Expected: PASS for all date separator, bubble timestamp, and mixed-role ordering assertions.

### Task 4: Make cloud reconciliation use the same chronological order

**Files:**
- Modify: `public/js/sync.js:224-305`
- Test: `test/chat-date-time.test.js`

**Interfaces:**
- Consumes `ChatTimeModule.getTimeInfo` and `ChatTimeModule.sortMessages` from Task 1.
- `mergeCloudMessages()` preserves cloud `createdAt`, derives local display parts when needed, and sorts each chat with the shared stable chronological comparator after an insert/update.

- [ ] **Step 1: Add the failing local/cloud merge test**

  Seed a chat with a local 21:00 system prompt lacking `createdAt`, pull a cloud 20:00 system prompt with `createdAt`, and assert the final order is 20:00 then 21:00. Also assert equal timestamps preserve insertion order and an existing cloud message is not duplicated.

- [ ] **Step 2: Run the focused test and verify it fails**

  Run: `node --test test/chat-date-time.test.js`

  Expected: FAIL with the current `sortTime()` behavior because one missing timestamp causes the comparator to return `0`.

- [ ] **Step 3: Replace the partial comparator with the shared sort**

  Remove the local `sortTime()` implementation, normalize legacy same-day `HH:mm` records with an explicit local-date fallback, and call the shared stable sorter. Do not sort API-only messages or alter the cloud query contract.

- [ ] **Step 4: Run the focused test and verify it passes**

  Run: `node --test test/chat-date-time.test.js`

  Expected: PASS with the earlier cloud message displayed before the later local message and no duplicate rows.

### Task 5: Full verification and compatibility review

**Files:**
- Modify: none unless verification exposes a regression
- Test: `test/chat-date-time.test.js`, existing `test/*.test.js`

- [ ] **Step 1: Run the focused regression suite**

  Run: `node --test test/chat-date-time.test.js test/chat-diary-card.test.js test/sync-proactive.test.js test/proactive-message-utils.test.js`

  Expected: PASS, including existing diary-card and proactive restoration behavior.

- [ ] **Step 2: Run the complete project test suite**

  Run: `npm test`

  Expected: PASS with no unrelated test failures.

- [ ] **Step 3: Re-run the original three-symptom VM reproduction**

  Verify the prior red-capable reproduction now reports: both user and AI non-today dates; the date header before a first system message; and `['猫砂盆好像需要铲一铲', '确认欲']` for the 20:00/21:00 case.

- [ ] **Step 4: Review the diff for timestamp contract coverage**

  Confirm no active chat-visible producer still creates a new message with only `time`, no new `dateDivider` writes exist, and all debug-only instrumentation or temporary fixtures are absent.
