const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../codex-message-sync');

test('Codex sync metadata is allowlisted and never carries session or gateway secrets', () => {
  const row = sync.normalizeCodexMessage({
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'turn-1-a',
    role: 'assistant', content: 'partial', created_at: '2026-10-05T00:00:00.000Z',
    metadata: {
      runtime: 'codex-gateway', turnId: 'turn-1', turnStatus: 'running',
      messageIndex: 0, updatedAt: '2026-10-05T00:00:01.000Z',
      sessionId: 'gs_' + 'f'.repeat(64), gatewayUrl: 'https://private.example', token: 'secret'
    }
  });
  assert.deepEqual(row.metadata, {
    runtime: 'codex-gateway', turnId: 'turn-1', turnStatus: 'running',
    messageIndex: 0, updatedAt: '2026-10-05T00:00:01.000Z'
  });
  assert.doesNotMatch(JSON.stringify(row), /sessionId|private\.example|secret/);
});

test('Codex sync rejects other projects and invalid turn statuses', () => {
  assert.equal(sync.normalizeCodexMessage({ project_id: 'p1', window_id: 'c1', message_id: 'm1', role: 'user', content: 'x' }), null);
  assert.equal(sync.normalizeCodexMessage({ project_id: 'codex-code-test', window_id: 'c1', message_id: 'm1', role: 'user', content: 'x', metadata: { turnStatus: 'maybe' } }), null);
});

test('Codex sync terminal status wins over stale running updates', () => {
  const completed = { metadata: { runtime: 'codex-gateway', turnId: 't1', turnStatus: 'completed', updatedAt: '2026-10-05T00:00:03.000Z' } };
  const stale = { metadata: { runtime: 'codex-gateway', turnId: 't1', turnStatus: 'running', updatedAt: '2026-10-05T00:00:04.000Z' } };
  assert.equal(sync.shouldApplyCodexUpdate(completed, stale), false);
  assert.equal(sync.shouldApplyCodexUpdate(stale, completed), true);
  const versionedCompleted = { metadata: { runtime: 'codex-gateway', turnId: 't1', turnStatus: 'completed', version: 2, updatedAt: '2026-10-05T00:00:03.000Z' } };
  const oldRunning = { metadata: { runtime: 'codex-gateway', turnId: 't1', turnStatus: 'running', version: 1, updatedAt: '2026-10-05T00:00:04.000Z' } };
  assert.equal(sync.shouldApplyCodexUpdate(versionedCompleted, oldRunning), false);
});

test('Codex sync rejects an equal-version conflicting terminal update deterministically', () => {
  const completed = { role: 'assistant', content: 'done', metadata: {
    runtime: 'codex-gateway', turnId: 't1', turnStatus: 'completed', version: 2,
    writerId: 'writer-a', updatedAt: '2026-10-05T00:00:03.000Z'
  } };
  const failed = { role: 'assistant', content: 'done', metadata: {
    runtime: 'codex-gateway', turnId: 't1', turnStatus: 'failed', version: 2,
    writerId: 'writer-b', updatedAt: '2026-10-05T00:00:03.000Z'
  } };
  assert.equal(sync.shouldApplyCodexUpdate(completed, failed), false);
  assert.equal(sync.shouldApplyCodexUpdate(failed, completed), true);
});

test('Codex conversation query is project-scoped, exact-window, sorted, and bounded', () => {
  assert.deepEqual(sync.buildCodexConversationQuery({ projectId: 'codex-code-test', windowId: 'chat-1', cursor: '25', limit: 25 }), {
    projectId: 'codex-code-test', windowId: 'chat-1', cursor: '25', limit: 25
  });
  assert.throws(() => sync.buildCodexConversationQuery({ projectId: 'p1' }), /CODEX_SYNC_INVALID_REQUEST/);
  assert.throws(() => sync.buildCodexConversationQuery({ projectId: 'codex-code-test', limit: 501 }), /CODEX_SYNC_INVALID_REQUEST/);
});
