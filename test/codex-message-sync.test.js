const test = require('node:test');
const assert = require('node:assert/strict');
const sync = require('../codex-message-sync');

function makeOversizedReceipts() {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const longPath = 'x'.repeat(1850);
  return {
    activities: Array.from({ length: 64 }, (_, activityIndex) => {
      const activityId = 'wa_' + (activityIndex + 1);
      return {
        requestId, activityId, tool: 'web_search', phase: 'completed',
        action: 'search', outcome: 'unknown', sources: 'available',
        sourceCards: Array.from({ length: 8 }, (_, sourceIndex) => {
          const hex = (activityIndex * 8 + sourceIndex).toString(16).padStart(64, '0');
          const displayUrl = 'https://example.org/' + longPath + '-' + activityIndex + '-' + sourceIndex;
          return {
            requestId, activityId, sourceId: 'ws_' + hex,
            displayUrl, url: displayUrl, redacted: false,
            title: 'source-' + activityIndex + '-' + sourceIndex, refId: 'ref_' + sourceIndex
          };
        })
      };
    })
  };
}

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

test('Codex sync accepts only bounded public receipt summaries', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'a'.repeat(64);
  const row = sync.normalizeCodexMessage({
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'user-1',
    role: 'user', content: '查资料', created_at: '2026-10-05T00:00:00.000Z',
    metadata: {
      runtime: 'codex-gateway', turnId: 'turn-1', turnStatus: 'completed',
      updatedAt: '2026-10-05T00:00:03.000Z',
      receipts: { activities: [{
        requestId, activityId, tool: 'web_search', phase: 'completed',
        action: 'search', outcome: 'unknown', sources: 'available',
        sourceCards: [{ requestId, activityId, sourceId,
          displayUrl: 'https://example.org/article', url: 'https://example.org/article',
          redacted: false, title: '<untrusted>', refId: 'ref_1' }]
      }] }
    }
  });
  assert.equal(row.metadata.receipts.activities[0].sourceCards[0].url, 'https://example.org/article');
  assert.equal(row.metadata.receipts.activities[0].sourceCards[0].title, '<untrusted>');
  assert.doesNotMatch(JSON.stringify(row), /sessionId|threadId|toolResult|signed/);

  const redacted = structuredClone(row);
  redacted.metadata.receipts.activities[0].sourceCards[0].redacted = true;
  delete redacted.metadata.receipts.activities[0].sourceCards[0].url;
  assert.ok(sync.normalizeCodexMessage(redacted));

  const unsafe = structuredClone(row);
  unsafe.metadata.receipts.activities[0].sourceCards[0].url = 'https://example.org/article?token=signed';
  assert.equal(sync.normalizeCodexMessage(unsafe), null);
});

test('Codex sync compacts oversized receipts while preserving all activity identities and terminal states', () => {
  const receipts = makeOversizedReceipts();
  const row = sync.normalizeCodexMessage({
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'oversized-receipt',
    role: 'user', content: '查资料', created_at: '2026-10-05T00:00:00.000Z',
    metadata: {
      runtime: 'codex-gateway', turnId: 'turn-oversized', turnStatus: 'completed',
      updatedAt: '2026-10-05T00:00:03.000Z', receipts
    }
  });

  assert.ok(row);
  const compacted = row.metadata.receipts;
  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= 64 * 1024);
  assert.equal(compacted.omitted, true);
  assert.ok(compacted.omittedSources > 0);
  assert.equal(compacted.activities.length, 64);
  assert.equal(compacted.activities[0].activityId, 'wa_1');
  assert.equal(compacted.activities[0].phase, 'completed');
  assert.equal(compacted.activities[63].activityId, 'wa_64');
  assert.equal(compacted.activities[63].phase, 'completed');
  assert.equal(row.metadata.turnStatus, 'completed');
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
