# Unified Email Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make manual chat emails, desire-driven proactive emails, and TODO wake-up emails use one backend sender, one `emailState` configuration, one daily quota, and one explicit marker parser.

**Architecture:** Keep the existing Express and cron entry points, but extract the Resend call, configuration gates, reservation-based quota accounting, diagnostics, and release-on-failure behavior into a shared backend email service. The service uses `EMAIL_FROM` when configured and retains the existing Resend test sender as its fallback. Reuse the existing proactive marker parser for desire and TODO paths, and atomically claim a due TODO before generating/sending so repeated scans cannot send the same wake-up twice.

**Tech Stack:** Node.js CommonJS, Express 5, native `fetch`, Supabase `app_state`/`project_todos`, Node test runner.

**Spec:** Current user request: “请根据已完成的定位修复邮件路径，直接实施并测试……”

## Global Constraints

- Do not change Resend keys, add a custom domain, deploy, or push. Commit the verified local changes only when requested.
- The `/api/email/config`-managed `emailState` is the only email configuration source.
- A send counts only after Resend returns a valid `emailId`; failed sends release their quota reservation.
- Logs may contain only source, requestId, Resend status, emailId, error name, and error message; never keys, Authorization, or email body.
- Only explicit `[[EMAIL:subject|body]]`/existing compatible EMAIL marker forms trigger sending; ordinary text and code blocks do not.

## Review Focus

- Concurrent manual/desire/TODO sends must not exceed the shared daily quota; test the reservation and release path in parallel.
- A Resend 2xx response without an id must remain a failure and must not count; pin this in the shared sender tests.
- TODO wake-up scans must atomically claim one todo before work; pin duplicate processing with two concurrent claims.
- TODO content shown in chat/ntfy must not contain the raw EMAIL marker after parsing; pin this in the wake-up action tests.
- An email failure must still save the proactive event and dispatch the existing notification flow; pin this at the proactive integration seam.
- Email configuration endpoints must distinguish in-memory updates from durable Supabase persistence and return a failure response when the database write fails.

### Task 1: Shared sender and persisted email state

**Files:**
- Create: `email-service.js`
- Modify: `server.js:email state initialization, config persistence, EMAIL_FROM, and /api/email/send`
- Modify: `.env.example:RESEND_API_KEY and EMAIL_FROM`
- Test: `test/email-service.test.js`

**Interfaces:**
- Produces `createEmailService({ state, apiKey, from, fetchImpl, persistState, logger, now })` with `send({ source, requestId, subject, body })` returning `{ emailId, requestId, resendStatus, source, sentToday, maxPerDay }` or throwing a typed error with HTTP status metadata.
- `server.js` passes the existing `emailState`, Resend key, native fetch, `saveEmailConfig`, and existing log functions; no HTTP self-call.

- [x] Write failing tests for shared config gates, unified recipients/sender, success counting, missing-id failure, error release, and concurrent quota reservation.
- [x] Run `node --test test/email-service.test.js` and confirm expected failures before implementation.
- [x] Implement the shared service with serialized reserve/release state transitions, daily reset, persisted `sentToday`/`sentDate`, and source-aware redacted diagnostics.
- [x] Route `/api/email/send` through the service while preserving compatible status/JSON fields and returning `emailId` on success.
- [x] Run the focused sender tests and confirm they pass.
- [x] Add `EMAIL_FROM` coverage, durable-config failure coverage, and document the env fallback.

### Task 2: Shared proactive marker parsing and TODO email execution

**Files:**
- Create or modify: `proactive-email-utils.js`
- Modify: `server.js:parseProactiveReply, checkTodoWakeUps, buildTodoWakeMessage`
- Test: `test/proactive-email-utils.test.js`

**Interfaces:**
- Produces one explicit parser for proactive content that returns cleaned display text and at most one email action according to the existing marker protocol.
- TODO and desire paths consume the same parser output; code fences and ordinary prose do not produce an email action.

- [x] Write failing tests for explicit markers, ordinary text, code fences, multiple markers, and cleaned visible content.
- [x] Run the focused parser tests and confirm expected failures.
- [x] Move/reuse the parser without changing non-email action semantics; process only the first explicit email marker and strip all raw markers from display content.
- [x] Add TODO wake-up handling that calls the shared sender when an email action exists, without adding a synthetic success message on failure.
- [x] Run parser and TODO action tests and confirm they pass.

### Task 3: Atomic TODO claim and proactive integration behavior

**Files:**
- Modify: `server.js:checkTodoWakeUps, checkProjectDesires`
- Test: `test/proactive-email-utils.test.js`, `test/email-service.test.js`

**Interfaces:**
- TODO processing claims a due row with a conditional `triggered=false` update before generating/sending; a lost claim exits without another email.
- Desire and TODO paths use `emailState` and the shared sender, retain event persistence and ntfy dispatch, and pass `source` as `desire` or `todo`.

- [x] Write failing seam tests for desire/TODO shared config and quota, duplicate TODO claims, cleaned visible content, and preserved control flow after email failure.
- [x] Run the focused proactive path tests and confirm expected failures.
- [x] Implement the minimal integration and atomic claim changes; do not alter custom-domain or deployment configuration.
- [x] Run focused tests, then `npm test` for the full suite.
- [x] Inspect `git diff`, `git status`, and verify no push/deploy occurred before the requested local commit.

- [x] Commit the verified local changes without pushing or deploying.
