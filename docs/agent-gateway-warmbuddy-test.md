# WarmBuddy Claude Code Test Agent Gateway Contract

This document is the deployment contract for the fixed `claude-code-test` project in the WarmBuddy MVP. The backend implementation lives in this repository; the Gateway implementation lives on the Android/Termux host at `/root/neverland/gateway/server.mjs`.

## Fixed values

- Public Gateway: `https://agent.maysneverland.com`
- Gateway project id: `warmbuddy-test`
- Default run mode: isolated request (`resume: false`)
- Books root: `/root/neverland/books`
- Claude system policy transport: `--append-system-prompt`
- Backend environment variables: `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_TOKEN`, `AGENT_GATEWAY_TIMEOUT_MS`

The browser must never receive or send the Gateway token, Gateway URL, Claude model flags, working directory, tool definitions, or arbitrary Gateway project ids.

## Agent Gateway JSON interface

The backend sends only this shape to `POST /v1/agent/run`:

```json
{
  "projectId": "warmbuddy-test",
  "conversationId": "claude-code-test-chat",
  "prompt": "...serialized WarmBuddy canonical context...",
  "resume": false
}
```

The Gateway returns JSON with the existing handoff shape:

```json
{
  "ok": true,
  "projectId": "warmbuddy-test",
  "conversationId": "claude-code-test-chat",
  "resumed": false,
  "result": "assistant text",
  "sessionId": null,
  "usage": null,
  "durationMs": 1234
}
```

The backend adapts `result` to the existing WarmBuddy SSE response:

```text
data: {"text":"assistant text"}

data: [DONE]

```

## Gateway enforcement

The Gateway must reject any `projectId` other than `warmbuddy-test` and must not accept caller-provided model, cwd, or tool allowlist values. The only allowed MCP tool names for this MVP are:

```text
reading_import_book
reading_list_books
reading_get_manifest
reading_search
reading_search_exact
reading_get_chunk
reading_get_progress
reading_read_note
reading_resume_book
reading_update_progress
reading_update_note
```

The fixed appended system policy must contain these requirements:

```text
reading_import_book 只能从 ~/neverland/books/ 导入
不得读取任意其他路径
不得把用户未明确指定的文件当作书籍导入
```

Prompt text is not the only enforcement layer. Before invoking `reading_import_book`, resolve the requested path against `/root/neverland/books` and reject:

- absolute paths outside `/root/neverland/books`;
- `..` traversal that escapes the root;
- symlinks whose real target is outside the root;
- imports where the user did not explicitly name a file in the request.

Use the canonical resolved path for the MCP call and compare it against the canonical books root with a path-segment-aware check. Do not use a string prefix check alone (`/root/neverland/books-evil` must not pass).

Claude must be launched with `--append-system-prompt` so the existing CLI harness remains active. The Gateway should not patch or replace the Claude CLI harness.

## Android deployment checklist

In `/root/neverland/gateway/server.mjs`:

1. Add `warmbuddy-test` to the fixed project map.
2. Reject all project ids except the fixed allowlisted projects.
3. Make `resume:false` the default and do not require session resume for this MVP.
4. Set the exact 11-tool allowlist above; do not pass an arbitrary browser allowlist through.
5. Append the fixed WarmBuddy/MCP policy with `--append-system-prompt`.
6. Add the canonical books-root and explicit-filename checks before MCP execution.
7. Keep bearer tokens out of logs and error bodies.

In the Gateway environment, configure the backend token separately from the Gateway's own process secrets. Do not commit either token.

## Verification commands

```bash
curl -sS https://agent.maysneverland.com/health

curl -sS -X POST https://agent.maysneverland.com/v1/agent/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <token>' \
  -d '{"projectId":"warmbuddy-test","conversationId":"gateway-check","prompt":"列出可用书籍","resume":false}'
```

Verify on the Android host that:

- `reading_list_books` succeeds;
- an explicitly named book under `/root/neverland/books` can be imported;
- traversal, an outside absolute path, a symlink to an outside file, and an import with no named file are rejected;
- a request with `projectId: "reading"` is rejected for this fixed test endpoint;
- logs contain no bearer token;
- the backend `/api/agent/stream` returns WarmBuddy SSE text and `[DONE]`.
