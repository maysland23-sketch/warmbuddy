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

const GITHUB_PROFILE = 'github-mcp-v1';

function makeCodexMessage(metadata, overrides = {}) {
  return Object.assign({
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'metadata-test',
    role: 'user', content: '查资料', created_at: '2026-10-05T00:00:00.000Z',
    metadata
  }, overrides);
}

function makeMixedReceipts() {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const webSource = {
    requestId, activityId: 'wa_1', sourceId: 'ws_' + '1'.padStart(64, '0'),
    displayUrl: 'https://example.org/article', url: 'https://example.org/article', redacted: false
  };
  const githubSource = {
    requestId, activityId: 'wa_2', sourceId: 'ws_' + '2'.padStart(64, '0'),
    displayUrl: 'https://github.com/neverland/warmbuddy/blob/main/README.md',
    url: 'https://github.com/neverland/warmbuddy/blob/main/README.md',
    redacted: false, linkKind: 'constructed'
  };
  return {
    activities: [
      {
        requestId, activityId: 'wa_1', tool: 'web_search', phase: 'completed',
        action: 'search', outcome: 'unknown', sources: 'available', sourceCards: [webSource]
      },
      {
        requestId, activityId: 'wa_2', tool: 'github_mcp', phase: 'completed',
        action: 'search_code', outcome: 'failed', reason: 'tool_failed',
        sources: 'available', sourceCards: [githubSource]
      },
      {
        requestId, activityId: 'wa_3', tool: 'github_mcp', phase: 'interrupted',
        action: 'list_commits', outcome: 'unknown', reason: 'cancelled', sourceCards: []
      },
      {
        requestId, activityId: 'wa_4', tool: 'github_mcp', phase: 'started',
        action: 'get_file_contents', outcome: 'unknown', sourceCards: []
      }
    ]
  };
}

function makeOversizedMixedReceipts() {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  return {
    activities: Array.from({ length: 64 }, (_, activityIndex) => {
      const activityId = 'wa_' + (activityIndex + 1);
      const isGithub = activityIndex % 2 === 0;
      const tool = isGithub ? 'github_mcp' : 'web_search';
      const action = isGithub
        ? ['search_repositories', 'search_code', 'get_file_contents', 'list_commits'][activityIndex % 4]
        : 'search';
      const outcome = isGithub && activityIndex === 0 ? 'failed' : 'unknown';
      const urlPrefix = isGithub
        ? 'https://github.com/neverland/warmbuddy/blob/main/'
        : 'https://example.org/reference/';
      const sourceCards = Array.from({ length: 8 }, (_, sourceIndex) => {
        const sourceId = 'ws_' + (activityIndex * 8 + sourceIndex).toString(16).padStart(64, '0');
        const url = urlPrefix + 'x'.repeat(1800) + sourceIndex;
        return Object.assign({
          requestId, activityId, sourceId, displayUrl: url, url, redacted: false
        }, isGithub ? { linkKind: 'constructed' } : {});
      });
      return Object.assign({
        requestId, activityId, tool, phase: 'completed', action, outcome,
        sources: 'available', sourceCards
      }, outcome === 'failed' ? { reason: 'tool_failed' } : {});
    })
  };
}

function normalizeProtectedReceiptMessage(receipts, messageId = 'protected-guard') {
  const row = sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-protected-guard', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: GITHUB_PROFILE, receipts
  }, { message_id: messageId }));
  assert.ok(row);
  return row;
}

function assertProtectedConflict(existing, incoming) {
  assert.throws(
    () => sync.assertCodexProtectedUpdate(existing, incoming, GITHUB_PROFILE),
    error => error.code === 'CODEX_RECEIPT_UPDATE_CONFLICT' && error.status === 409
  );
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

test('Codex metadata keeps legacy web receipts and negotiates receiptProfile independent of field order', () => {
  const receipts = makeMixedReceipts();
  const baseMetadata = {
    runtime: 'codex-gateway', turnId: 'turn-profile', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z'
  };
  const receiptsFirst = sync.normalizeCodexMessage(makeCodexMessage({
    ...baseMetadata, receipts, receiptProfile: GITHUB_PROFILE
  }));
  const profileFirst = sync.normalizeCodexMessage(makeCodexMessage({
    ...baseMetadata, receiptProfile: GITHUB_PROFILE, receipts
  }, { message_id: 'metadata-test-reordered' }));
  assert.deepEqual(receiptsFirst.metadata, profileFirst.metadata);
  assert.equal(receiptsFirst.metadata.receiptProfile, GITHUB_PROFILE);
  assert.equal(receiptsFirst.metadata.receipts.activities[1].tool, 'github_mcp');
  assert.equal(receiptsFirst.metadata.receipts.activities[1].outcome, 'failed');
  assert.equal(receiptsFirst.metadata.receipts.activities[1].reason, 'tool_failed');
  assert.equal(receiptsFirst.metadata.receipts.activities[2].reason, 'cancelled');
  assert.equal(receiptsFirst.metadata.receipts.activities[0].sourceCards[0].linkKind, undefined);
  assert.equal(receiptsFirst.metadata.receipts.activities[1].sourceCards[0].linkKind, 'constructed');

  const legacyWeb = sync.normalizeCodexMessage(makeCodexMessage({
    ...baseMetadata,
    receipts: {
      activities: [receipts.activities[0]]
    }
  }, { message_id: 'legacy-web-receipt' }));
  assert.ok(legacyWeb);
  assert.equal(Object.prototype.hasOwnProperty.call(legacyWeb.metadata, 'receiptProfile'), false);
});

test('Codex metadata rejects incompatible profile states without inferring or silently upgrading', () => {
  const githubReceipts = makeMixedReceipts();
  assert.equal(sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-no-profile', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receipts: githubReceipts
  })), null);
  assert.equal(sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-bad-profile', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: 'github-mcp-v2', receipts: githubReceipts
  })), null);
  assert.equal(sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-profile-no-receipts', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: GITHUB_PROFILE
  })), null);
  assert.equal(sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-profile-undefined', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: undefined, receipts: { activities: [] }
  })), null);

  const emptyProfile = sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-empty-profile', turnStatus: 'completed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: GITHUB_PROFILE,
    receipts: { activities: [] }
  }, { message_id: 'empty-profile' }));
  assert.ok(emptyProfile);
  assert.deepEqual(emptyProfile.metadata.receipts, { activities: [] });
});

test('Codex protected updates reject same-count activity identity and core semantic replacement', () => {
  const existing = normalizeProtectedReceiptMessage(makeMixedReceipts(), 'protected-core-guards');

  const replacedTool = structuredClone(makeMixedReceipts());
  replacedTool.activities[1].tool = 'web_search';
  replacedTool.activities[1].action = 'search';
  replacedTool.activities[1].outcome = 'unknown';
  delete replacedTool.activities[1].reason;
  delete replacedTool.activities[1].sourceCards[0].linkKind;
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(replacedTool, 'protected-core-guards'));

  const replacedIdentity = structuredClone(makeMixedReceipts());
  replacedIdentity.activities[1].activityId = 'wa_9';
  replacedIdentity.activities[1].sourceCards[0].activityId = 'wa_9';
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(replacedIdentity, 'protected-core-guards'));

  const erasedFailure = structuredClone(makeMixedReceipts());
  erasedFailure.activities[1].outcome = 'unknown';
  delete erasedFailure.activities[1].reason;
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(erasedFailure, 'protected-core-guards'));
});

test('Codex protected updates enforce lifecycle monotonicity while allowing valid started settlement and new activities', () => {
  const existing = normalizeProtectedReceiptMessage(makeMixedReceipts(), 'protected-lifecycle');

  const completedToStarted = structuredClone(makeMixedReceipts());
  completedToStarted.activities[0].phase = 'started';
  delete completedToStarted.activities[0].sources;
  completedToStarted.activities[0].sourceCards = [];
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(completedToStarted, 'protected-lifecycle'));

  const completedToInterrupted = structuredClone(makeMixedReceipts());
  completedToInterrupted.activities[0].phase = 'interrupted';
  completedToInterrupted.activities[0].reason = 'cancelled';
  delete completedToInterrupted.activities[0].sources;
  completedToInterrupted.activities[0].sourceCards = [];
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(completedToInterrupted, 'protected-lifecycle'));

  const settledStarted = structuredClone(makeMixedReceipts());
  settledStarted.activities[3].phase = 'interrupted';
  settledStarted.activities[3].reason = 'cancelled';
  assert.doesNotThrow(() => sync.assertCodexProtectedUpdate(
    existing,
    normalizeProtectedReceiptMessage(settledStarted, 'protected-lifecycle'),
    GITHUB_PROFILE
  ));

  const withNewActivity = structuredClone(makeMixedReceipts());
  withNewActivity.activities.push({
    requestId: withNewActivity.activities[0].requestId, activityId: 'wa_5', tool: 'github_mcp',
    phase: 'started', action: 'search_repositories', outcome: 'unknown', sourceCards: []
  });
  assert.doesNotThrow(() => sync.assertCodexProtectedUpdate(
    existing,
    normalizeProtectedReceiptMessage(withNewActivity, 'protected-lifecycle'),
    GITHUB_PROFILE
  ));
});

test('Codex protected web activities can bind an unknown started action only while settling', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const makeWebReceipts = (phase, action) => ({
    activities: [Object.assign({
      requestId, activityId: 'wa_1', tool: 'web_search', phase, action,
      outcome: 'unknown', sourceCards: []
    }, phase === 'completed' ? { sources: 'none' } : {})]
  });

  for (const action of ['search', 'open_page']) {
    const existing = normalizeProtectedReceiptMessage(
      makeWebReceipts('started', 'unknown'),
      'protected-web-action-' + action
    );
    const incoming = normalizeProtectedReceiptMessage(
      makeWebReceipts('completed', action),
      'protected-web-action-' + action
    );
    assert.doesNotThrow(() => sync.assertCodexProtectedUpdate(existing, incoming, GITHUB_PROFILE));
  }

  const knownAction = normalizeProtectedReceiptMessage(
    makeWebReceipts('started', 'search'),
    'protected-web-known-action'
  );
  assertProtectedConflict(knownAction, normalizeProtectedReceiptMessage(
    makeWebReceipts('completed', 'open_page'),
    'protected-web-known-action'
  ));
  assertProtectedConflict(knownAction, normalizeProtectedReceiptMessage(
    makeWebReceipts('completed', 'unknown'),
    'protected-web-known-action'
  ));

  const terminal = normalizeProtectedReceiptMessage(
    makeWebReceipts('completed', 'search'),
    'protected-web-terminal-action'
  );
  assertProtectedConflict(terminal, normalizeProtectedReceiptMessage(
    makeWebReceipts('completed', 'open_page'),
    'protected-web-terminal-action'
  ));

  const github = normalizeProtectedReceiptMessage(makeMixedReceipts(), 'protected-github-action');
  const githubActionChange = structuredClone(makeMixedReceipts());
  githubActionChange.activities[1].action = 'list_commits';
  assertProtectedConflict(github, normalizeProtectedReceiptMessage(
    githubActionChange,
    'protected-github-action'
  ));
});

test('Codex protected updates distinguish late sources from silent deletion and allow a legal compact summary', () => {
  const full = makeMixedReceipts();
  const existing = normalizeProtectedReceiptMessage(full, 'protected-sources');

  const deletedSource = structuredClone(full);
  deletedSource.activities[0].sources = 'none';
  deletedSource.activities[0].sourceCards = [];
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(deletedSource, 'protected-sources'));

  const lateSource = structuredClone(full);
  lateSource.activities[0].sourceCards.push({
    requestId: lateSource.activities[0].requestId, activityId: 'wa_1',
    sourceId: 'ws_' + '3'.repeat(64), displayUrl: 'https://example.org/late',
    url: 'https://example.org/late', redacted: false
  });
  assert.doesNotThrow(() => sync.assertCodexProtectedUpdate(
    existing,
    normalizeProtectedReceiptMessage(lateSource, 'protected-sources'),
    GITHUB_PROFILE
  ));

  const compactSummary = structuredClone(full);
  compactSummary.omitted = true;
  compactSummary.omittedSources = 2;
  compactSummary.activities[0].sourceCards = [];
  compactSummary.activities[1].sourceCards = [];
  assert.doesNotThrow(() => sync.assertCodexProtectedUpdate(
    existing,
    normalizeProtectedReceiptMessage(compactSummary, 'protected-sources'),
    GITHUB_PROFILE
  ));

  const nonPrefixSummary = structuredClone(full);
  nonPrefixSummary.omitted = true;
  nonPrefixSummary.omittedSources = 1;
  nonPrefixSummary.activities[0].sourceCards = [];
  assertProtectedConflict(existing, normalizeProtectedReceiptMessage(nonPrefixSummary, 'protected-sources'));
});

test('Codex sync sends oversized mixed receipts through the shared compressor without changing terminal semantics', () => {
  const row = sync.normalizeCodexMessage(makeCodexMessage({
    runtime: 'codex-gateway', turnId: 'turn-shared-compaction', turnStatus: 'failed',
    updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: GITHUB_PROFILE,
    receipts: makeOversizedMixedReceipts()
  }, { message_id: 'shared-compaction' }));

  assert.ok(row);
  const compacted = row.metadata.receipts;
  assert.ok(Buffer.byteLength(JSON.stringify(compacted), 'utf8') <= 64 * 1024);
  assert.equal(compacted.omitted, true);
  assert.ok(compacted.omittedSources > 0);
  assert.equal(compacted.activities.length, 64);
  assert.equal(compacted.activities[0].tool, 'github_mcp');
  assert.equal(compacted.activities[0].outcome, 'failed');
  assert.equal(compacted.activities[0].reason, 'tool_failed');
  assert.equal(compacted.activities[0].sourceCards[0].linkKind, 'constructed');
  assert.equal(compacted.activities[1].tool, 'web_search');
  assert.equal(compacted.activities[1].outcome, 'unknown');
  assert.equal(row.metadata.turnStatus, 'failed');
});

test('Codex user messages retain valid receipts for failed, canceled, and unknown turn statuses', () => {
  for (const turnStatus of ['failed', 'canceled', 'unknown']) {
    const row = sync.normalizeCodexMessage(makeCodexMessage({
      runtime: 'codex-gateway', turnId: 'turn-' + turnStatus, turnStatus,
      updatedAt: '2026-10-05T00:00:03.000Z', receiptProfile: GITHUB_PROFILE,
      receipts: makeMixedReceipts()
    }, { message_id: 'status-' + turnStatus }));
    assert.ok(row);
    assert.equal(row.metadata.turnStatus, turnStatus);
    assert.equal(row.metadata.receiptProfile, GITHUB_PROFILE);
    assert.equal(row.metadata.receipts.activities[1].outcome, 'failed');
    assert.equal(row.metadata.receipts.activities[2].reason, 'cancelled');
  }
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
