const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const contract = require('../public/js/codex-receipt-contract');

const REQUEST_ID = 'wr_00000000-0000-4000-8000-000000000001';
const PROFILE = 'github-mcp-v1';
const MAX_BYTES = 64 * 1024;

function source(activityId, sourceId, overrides = {}) {
  return Object.assign({
    requestId: REQUEST_ID,
    activityId,
    sourceId: 'ws_' + String(sourceId).padStart(64, '0'),
    displayUrl: 'https://example.org/reference/' + sourceId,
    redacted: false,
    url: 'https://example.org/reference/' + sourceId
  }, overrides);
}

function githubSource(activityId, sourceId, overrides = {}) {
  const url = 'https://github.com/neverland/warmbuddy/reference/' + sourceId;
  return source(activityId, sourceId, Object.assign({
    displayUrl: url,
    url,
    linkKind: 'constructed'
  }, overrides));
}

function activity(activityId, overrides = {}) {
  return Object.assign({
    requestId: REQUEST_ID,
    activityId,
    tool: 'web_search',
    phase: 'completed',
    action: 'search',
    outcome: 'unknown',
    sources: 'none',
    sourceCards: []
  }, overrides);
}

function githubActivity(activityId, action, overrides = {}) {
  const result = activity(activityId, Object.assign({
    tool: 'github_mcp',
    action,
    sourceCards: []
  }, overrides));
  if (result.phase !== 'completed' && !Object.prototype.hasOwnProperty.call(overrides, 'sources')) {
    delete result.sources;
  }
  return result;
}

function assertCode(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test('keeps a representative E1-A canonical receipt unchanged', () => {
  const fixture = {
    activities: [{
      requestId: REQUEST_ID,
      activityId: 'wa_1',
      tool: 'web_search',
      phase: 'completed',
      action: 'open_page',
      outcome: 'unknown',
      targetSourceId: 'ws_' + '1'.padStart(64, '0'),
      targetDisplayUrl: 'https://example.org/article',
      targetRedacted: false,
      targetUrl: 'https://example.org/article',
      sources: 'available',
      sourceCards: [source('wa_1', 2, {
        title: 'An E1-A source',
        refId: 'result_1'
      })]
    }]
  };

  assert.deepEqual(contract.normalizeReceiptSet(fixture), fixture);
});

test('guards receipt activity transitions before an SSE snapshot is published', () => {
  const startedUnknown = activity('wa_1', { phase: 'started', action: 'unknown' });
  const completedSearch = activity('wa_1', { phase: 'completed', action: 'search' });
  const completedOpenPage = activity('wa_1', { phase: 'completed', action: 'open_page' });
  const completedUnknown = activity('wa_1', { phase: 'completed', action: 'unknown' });
  const startedKnown = activity('wa_1', { phase: 'started', action: 'search' });
  const githubStarted = githubActivity('wa_1', 'search_code', { phase: 'started' });
  const githubOtherAction = githubActivity('wa_1', 'list_commits');

  assert.doesNotThrow(() => contract.assertActivityTransition(startedUnknown, completedSearch));
  assert.doesNotThrow(() => contract.assertActivityTransition(startedUnknown, completedOpenPage));
  assert.throws(() => contract.assertActivityTransition(startedKnown, completedOpenPage), /RECEIPT_INCOMPATIBLE_ACTIVITY/);
  assert.throws(() => contract.assertActivityTransition(startedKnown, completedUnknown), /RECEIPT_INCOMPATIBLE_ACTIVITY/);
  assert.throws(() => contract.assertActivityTransition(githubStarted, githubOtherAction), /RECEIPT_INCOMPATIBLE_ACTIVITY/);
  assert.throws(() => contract.assertActivityTransition(completedSearch, completedOpenPage), /RECEIPT_INCOMPATIBLE_ACTIVITY/);
  assert.throws(() => contract.assertActivityTransition(
    Object.assign({}, startedUnknown, { context: { owner: 'Neverland' } }),
    Object.assign({}, completedSearch, { context: { owner: 'OtherOwner' } })
  ), /RECEIPT_INCOMPATIBLE_ACTIVITY/);
});

test('normalizes mixed web and GitHub activities with all four GitHub actions', () => {
  const actions = [
    'search_repositories',
    'search_code',
    'get_file_contents',
    'list_commits'
  ];
  const fixture = {
    activities: [
      githubActivity('wa_4', actions[3], {
        sources: 'available',
        sourceCards: [source('wa_4', 4, {
          displayUrl: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
          url: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
          linkKind: 'constructed',
          context: { owner: 'neverland', repo: 'warmbuddy', commit: 'A'.repeat(40) }
        })]
      }),
      activity('wa_1', {
        sourceCards: [source('wa_1', 1)],
        sources: 'available'
      }),
      githubActivity('wa_2', actions[0], { phase: 'started', outcome: 'unknown' }),
      githubActivity('wa_3', actions[1], {
        phase: 'completed',
        outcome: 'failed',
        reason: 'tool_failed'
      }),
      githubActivity('wa_5', actions[2], {
        phase: 'interrupted',
        reason: 'cancelled'
      })
    ]
  };

  const normalized = contract.normalizeReceiptSet(fixture, { profile: PROFILE });
  assert.deepEqual(
    normalized.activities.filter(item => item.tool === 'github_mcp').map(item => item.action),
    [actions[3], actions[0], actions[1], actions[2]]
  );
  assert.equal(normalized.activities[0].sourceCards[0].linkKind, 'constructed');
  assert.equal(normalized.activities[0].context, undefined);
  assert.equal(normalized.activities[3].outcome, 'failed');
  assert.equal(normalized.activities[3].reason, 'tool_failed');
  assert.equal(normalized.activities[4].phase, 'interrupted');
  assert.equal(normalized.activities[4].outcome, 'unknown');
  assert.equal(normalized.activities[4].reason, 'cancelled');
  assert.equal(normalized.activities[1].sourceCards[0].activityId, 'wa_1');
  assert.equal(normalized.activities[1].sourceCards[0].linkKind, undefined);
});

test('requires the profile for GitHub activities and does not accept GitHub targets as web pages', () => {
  const github = { activities: [githubActivity('wa_1', 'search_code')] };
  assertCode(() => contract.normalizeReceiptSet(github), 'RECEIPT_PROFILE_REQUIRED');
  assertCode(
    () => contract.normalizeReceiptSet(github, { profile: 'other-v1' }),
    'RECEIPT_PROFILE_UNSUPPORTED'
  );

  assertCode(() => contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'search_code', {
      targetSourceId: 'ws_' + '1'.padStart(64, '0'),
      targetDisplayUrl: 'https://github.com/neverland/warmbuddy',
      targetRedacted: false,
      targetUrl: 'https://github.com/neverland/warmbuddy'
    })]
  }, { profile: PROFILE }), 'RECEIPT_INVALID_ACTIVITY');
});

test('enforces phase, outcome, reason, completion sources, and source association rules', () => {
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { outcome: 'failed' })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { phase: 'started', outcome: 'unknown', sources: 'none' })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { phase: 'interrupted', sourceCards: [] })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { phase: 'completed', sources: undefined })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'search_code', {
      outcome: 'failed',
      reason: 'round_failed'
    })]
  }, { profile: PROFILE }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      phase: 'started',
      sourceCards: [source('wa_1', 1)]
    })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_2', 1)]
    })]
  }), 'RECEIPT_INVALID_SOURCE');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [
      activity('wa_1'),
      activity('wa_1')
    ]
  }), 'RECEIPT_INVALID_ACTIVITY');
});

test('rejects inherited enum names and non-string enum values', () => {
  const phaseWithoutSources = activity('wa_1', { phase: 'toString' });
  delete phaseWithoutSources.sources;
  const invalidCases = [
    { activities: [activity('wa_1', { action: 'toString' })] },
    { activities: [activity('wa_1', { action: '__proto__' })] },
    { activities: [phaseWithoutSources] },
    { activities: [activity('wa_1', { sources: 'constructor' })] },
    { activities: [githubActivity('wa_1', 'search_code', { phase: 'interrupted', reason: 'toString' })] },
    { activities: [githubActivity('wa_1', 'search_code', { phase: 'interrupted', reason: '__proto__' })] }
  ];
  for (const fixture of invalidCases) {
    assertCode(
      () => contract.normalizeReceiptSet(fixture, { profile: PROFILE }),
      'RECEIPT_INVALID_ACTIVITY'
    );
  }
});

test('requires real string IDs, bounds activity IDs, and rejects omission counter overflow', () => {
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity(['wa_1'])]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_' + '1'.repeat(70000))]
  }), 'RECEIPT_INVALID_ACTIVITY');
  const maxActivityId = 'wa_' + '1'.repeat(125);
  const maxIdReceipt = contract.normalizeReceiptSet({
    activities: [activity(maxActivityId)]
  });
  assert.equal(maxIdReceipt.activities[0].activityId, maxActivityId);
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { requestId: [REQUEST_ID] })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_1', 1, { sourceId: ['ws_' + '1'.repeat(64)] })],
      sources: 'available'
    })]
  }), 'RECEIPT_INVALID_SOURCE');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      targetSourceId: ['ws_' + '1'.repeat(64)],
      targetDisplayUrl: 'https://example.org/article',
      targetRedacted: false,
      targetUrl: 'https://example.org/article',
      sources: 'none'
    })]
  }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    omitted: true,
    omittedSources: Number.MAX_SAFE_INTEGER + 1,
    activities: []
  }), 'RECEIPT_INVALID_OMISSION');
  const overflowFixture = largeMixedFixture();
  overflowFixture.omitted = true;
  overflowFixture.omittedSources = Number.MAX_SAFE_INTEGER;
  assertCode(
    () => contract.compactReceiptSet(overflowFixture, { profile: PROFILE }),
    'RECEIPT_INVALID_OMISSION'
  );
});

test('keeps tool_failed optional on a completed GitHub failure without adding an undefined field', () => {
  const normalized = contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'search_code', {
      outcome: 'failed'
    })]
  }, { profile: PROFILE });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.activities[0], 'reason'), false);
});

test('omits invalid context fields one by one using the exact bounded grammar', () => {
  const context = {
    owner: 'never--land',
    repo: 'warm_buddy-1',
    path: 'src/lib/file_name.js',
    ref: 'feature/release_1',
    commit: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01',
    unknown: 'do-not-copy'
  };
  const normalized = contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'get_file_contents', { context })]
  }, { profile: PROFILE });
  assert.deepEqual(normalized.activities[0].context, {
    repo: 'warm_buddy-1',
    path: 'src/lib/file_name.js',
    ref: 'feature/release_1',
    commit: 'abcdef0123456789abcdef0123456789abcdef01'
  });

  const invalidFields = [
    { owner: 'a--b' },
    { repo: 'bad repo' },
    { path: '/root/file' },
    { path: 'src//file' },
    { path: 'src/../file' },
    { path: '源文件.js' },
    { ref: 'feature//x' },
    { ref: 'foo..bar' },
    { ref: 'main.' },
    { ref: 'main.lock' },
    { commit: 'abc' }
  ];
  for (const field of invalidFields) {
    const result = contract.normalizeReceiptSet({
      activities: [githubActivity('wa_1', 'search_code', {
        context: Object.assign({ owner: 'owner', repo: 'repo' }, field)
      })]
    }, { profile: PROFILE });
    for (const key of Object.keys(field)) assert.equal(result.activities[0].context[key], undefined);
  }

  const rootPath = contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'search_code', { context: { owner: 'owner', repo: 'repo', path: '/' } })]
  }, { profile: PROFILE });
  assert.deepEqual(rootPath.activities[0].context, { owner: 'owner', repo: 'repo' });
});

test('drops unknown and synthesized sensitive fields without exposing them', () => {
  const normalized = contract.normalizeReceiptSet({
    extra: 'drop',
    activities: [githubActivity('wa_1', 'search_repositories', {
      query: 'private query',
      result: { content: 'private result' },
      resourceUri: 'github://private/resource',
      exception: 'secret stack',
      credentials: 'token',
      contentEvidence: 'not in v1',
      'content-shape': 'full',
      failureKind: 'tool',
      verified: true
    })]
  }, { profile: PROFILE });
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'extra'), false);
  for (const key of ['query', 'result', 'resourceUri', 'exception', 'credentials', 'contentEvidence', 'content-shape', 'failureKind', 'verified']) {
    assert.equal(Object.prototype.hasOwnProperty.call(normalized.activities[0], key), false);
  }
});

test('rejects malicious URLs, invalid source fields, and invalid core values', () => {
  const badUrls = [
    'https://example.org/article?token=secret',
    'https://example.org/article#fragment',
    'https://user:pass@example.org/article',
    'https://example.org:443/article',
    'https://127.0.0.1/article',
    'https://localhost/article',
    'https://example.test/article',
    'https://example.org/a b'
  ];
  for (const badUrl of badUrls) {
    assertCode(() => contract.normalizeReceiptSet({
      activities: [activity('wa_1', {
        sourceCards: [source('wa_1', 1, { displayUrl: badUrl, url: badUrl })],
        sources: 'available'
      })]
    }), 'RECEIPT_INVALID_SOURCE');
  }
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_1', 1, { linkKind: 'verified' })],
      sources: 'available'
    })]
  }), 'RECEIPT_INVALID_SOURCE');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', { tool: 'github_mcp' })]
  }, { profile: PROFILE }), 'RECEIPT_INVALID_ACTIVITY');
});

test('requires GitHub constructed sources to use exact HTTPS github.com', () => {
  const badUrls = [
    'https://example.org/reference/1',
    'https://www.github.com/neverland/warmbuddy/reference/1',
    'http://github.com/neverland/warmbuddy/reference/1'
  ];
  for (const badUrl of badUrls) {
    assertCode(() => contract.normalizeReceiptSet({
      activities: [githubActivity('wa_1', 'search_code', {
        sources: 'available',
        sourceCards: [githubSource('wa_1', 1, { displayUrl: badUrl, url: badUrl })]
      })]
    }, { profile: PROFILE }), 'RECEIPT_INVALID_SOURCE');
  }

  assert.doesNotThrow(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sources: 'available',
      sourceCards: [source('wa_1', 1)]
    })]
  }));
});

test('enforces exact byte limits and redaction combinations for retained source fields', () => {
  const validContext = {
    owner: 'a' + 'b'.repeat(37) + 'c',
    repo: 'r' + 's'.repeat(99),
    path: 'p'.repeat(512),
    ref: 'a/'.repeat(63) + 'aa',
    commit: 'B'.repeat(40)
  };
  const normalized = contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'get_file_contents', {
      context: validContext,
      sources: 'available',
      sourceCards: [githubSource('wa_1', 1, {
        title: 't'.repeat(256),
        refId: 'r'.repeat(128)
      })]
    })]
  }, { profile: PROFILE });
  assert.equal(normalized.activities[0].context.owner.length, 39);
  assert.equal(normalized.activities[0].context.repo.length, 100);
  assert.equal(normalized.activities[0].context.path.length, 512);
  assert.equal(normalized.activities[0].context.ref.length, 128);
  assert.equal(normalized.activities[0].context.commit, 'b'.repeat(40));

  const overLimitFields = [
    { owner: 'a'.repeat(40) },
    { repo: 'r'.repeat(101) },
    { path: 'p'.repeat(513) },
    { ref: 'a'.repeat(129) }
  ];
  for (const field of overLimitFields) {
    const result = contract.normalizeReceiptSet({
      activities: [githubActivity('wa_1', 'search_code', {
        context: Object.assign({ owner: 'owner', repo: 'repo' }, field)
      })]
    }, { profile: PROFILE });
    for (const key of Object.keys(field)) assert.equal(result.activities[0].context[key], undefined);
  }

  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_1', 1, { title: 't'.repeat(257) })],
      sources: 'available'
    })]
  }), 'RECEIPT_INVALID_SOURCE');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_1', 1, { refId: 'r'.repeat(129) })],
      sources: 'available'
    })]
  }), 'RECEIPT_INVALID_SOURCE');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [activity('wa_1', {
      sourceCards: [source('wa_1', 1, {
        redacted: true,
        url: undefined
      })],
      sources: 'available'
    })]
  }), 'RECEIPT_INVALID_SOURCE');
});

test('preserves the 64 activity and 8 source limits', () => {
  const activities = Array.from({ length: 64 }, (_, index) => githubActivity('wa_' + (index + 1), 'list_commits', {
    sources: 'available',
    sourceCards: Array.from({ length: 8 }, (_, sourceIndex) => source('wa_' + (index + 1), (index * 8) + sourceIndex + 1, {
      displayUrl: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
      url: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
      linkKind: 'constructed'
    }))
  }));
  const normalized = contract.normalizeReceiptSet({ activities }, { profile: PROFILE });
  assert.equal(normalized.activities.length, 64);
  assert.equal(normalized.activities[0].sourceCards.length, 8);
  assertCode(() => contract.normalizeReceiptSet({
    activities: activities.concat(githubActivity('wa_65', 'list_commits'))
  }, { profile: PROFILE }), 'RECEIPT_INVALID_ACTIVITY');
  assertCode(() => contract.normalizeReceiptSet({
    activities: [githubActivity('wa_1', 'list_commits', {
      sources: 'available',
      sourceCards: Array.from({ length: 9 }, (_, index) => source('wa_1', index + 1, {
        displayUrl: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
        url: 'https://github.com/neverland/warmbuddy/commit/' + 'a'.repeat(40),
        linkKind: 'constructed'
      }))
    })]
  }, { profile: PROFILE }), 'RECEIPT_INVALID_ACTIVITY');
});

function largeMixedFixture() {
  return {
    activities: Array.from({ length: 64 }, (_, index) => {
      const activityId = 'wa_' + (index + 1);
      const isGithub = index % 2 === 0;
      const tool = isGithub ? 'github_mcp' : 'web_search';
      const action = isGithub
        ? ['search_repositories', 'search_code', 'get_file_contents', 'list_commits'][index % 4]
        : 'search';
       const failed = isGithub && index % 8 === 0;
       const includeFailureReason = failed && index !== 0;
      return {
        requestId: REQUEST_ID,
        activityId,
        tool,
        phase: 'completed',
        action,
        outcome: failed ? 'failed' : 'unknown',
         ...(includeFailureReason ? { reason: 'tool_failed' } : {}),
        sources: 'available',
        sourceCards: Array.from({ length: 8 }, (_, sourceIndex) => {
          const url = isGithub
            ? 'https://github.com/neverland/warmbuddy/blob/main/' + 'a'.repeat(1800) + sourceIndex
            : 'https://example.org/reference/' + 'b'.repeat(1800) + sourceIndex;
          return source(activityId, (index * 8) + sourceIndex + 1, Object.assign({
            displayUrl: url,
            url
          }, isGithub ? {
            linkKind: 'constructed'
          } : {}));
        })
      };
    })
  };
}

test('compacts oversized mixed receipts with a global source prefix and preserves failure semantics', () => {
  const fixture = largeMixedFixture();
  assert.ok(utf8Bytes(fixture) > MAX_BYTES);
  const compacted = contract.compactReceiptSet(fixture, { profile: PROFILE });
  assert.ok(utf8Bytes(compacted) <= MAX_BYTES);
  assert.equal(compacted.omitted, true);
  assert.equal(compacted.activities.length, 64);

  for (let index = 0; index < compacted.activities.length; index++) {
    const before = fixture.activities[index];
    const after = compacted.activities[index];
    assert.equal(after.requestId, before.requestId);
    assert.equal(after.activityId, before.activityId);
    assert.equal(after.tool, before.tool);
    assert.equal(after.action, before.action);
    assert.equal(after.phase, before.phase);
    assert.equal(after.outcome, before.outcome);
    assert.equal(after.reason, before.reason);
    for (const retained of after.sourceCards) {
      assert.equal(retained.linkKind, after.tool === 'github_mcp' ? 'constructed' : undefined);
    }
  }

  const beforeSources = fixture.activities.flatMap(item => item.sourceCards.map(item => item.sourceId));
  const afterSources = compacted.activities.flatMap(item => item.sourceCards.map(item => item.sourceId));
  assert.deepEqual(afterSources, beforeSources.slice(0, afterSources.length));
  assert.equal(compacted.omittedSources, beforeSources.length - afterSources.length);
  assert.deepEqual(contract.normalizeReceiptSet(compacted, { profile: PROFILE }), compacted);
  assert.deepEqual(contract.compactReceiptSet(compacted, { profile: PROFILE }), compacted);
});

test('keeps failed-without-reason idempotent when compacting an oversized direct object', () => {
  const fixture = largeMixedFixture();
  assert.ok(utf8Bytes(fixture) > MAX_BYTES);
  const compacted = contract.compactReceiptSet(fixture, { profile: PROFILE });
  const failed = compacted.activities.find(item => item.outcome === 'failed' && item.activityId === 'wa_1');
  assert.equal(Object.prototype.hasOwnProperty.call(failed, 'reason'), false);
  assert.deepEqual(contract.normalizeReceiptSet(compacted, { profile: PROFILE }), compacted);
  assert.deepEqual(contract.compactReceiptSet(compacted, { profile: PROFILE }), compacted);
});

test('strips source display details before applying the global source prefix', () => {
  const largeSourceDetails = {
    title: 't'.repeat(256),
    refId: 'r'.repeat(128),
    context: {
      owner: 'o'.repeat(39),
      repo: 'r'.repeat(100),
      path: 'p'.repeat(512),
      ref: 'a'.repeat(128),
      commit: 'A'.repeat(40)
    }
  };
  const fixture = {
    activities: Array.from({ length: 64 }, (_, index) => {
      const activityId = 'wa_' + (index + 1);
      return githubActivity(activityId, 'search_code', {
        sources: 'available',
        sourceCards: [githubSource(activityId, index + 1, largeSourceDetails)]
      });
    })
  };
  assert.ok(utf8Bytes(fixture) > MAX_BYTES);
  const compacted = contract.compactReceiptSet(fixture, { profile: PROFILE });
  assert.ok(utf8Bytes(compacted) <= MAX_BYTES);
  assert.equal(compacted.omittedSources, 0);
  assert.equal(compacted.activities.every(item => item.sourceCards.length === 1), true);
  assert.equal(compacted.activities.every(item => item.sourceCards[0].title === undefined), true);
  assert.equal(compacted.activities.every(item => item.sourceCards[0].refId === undefined), true);
  assert.equal(compacted.activities.every(item => item.sourceCards[0].context === undefined), true);
  assert.equal(compacted.activities.every(item => item.sourceCards[0].linkKind === 'constructed'), true);
  assert.deepEqual(contract.normalizeReceiptSet(compacted, { profile: PROFILE }), compacted);
});

test('compacts oversized display context without claiming sources were omitted', () => {
  const largeContext = {
    owner: 'o'.repeat(39),
    repo: 'r'.repeat(100),
    path: Array(256).fill('p').join('/'),
    ref: Array(64).fill('r').join('/'),
    commit: 'A'.repeat(40)
  };
  const fixture = {
    activities: Array.from({ length: 64 }, (_, index) => {
      const activityId = 'wa_' + (index + 1);
      return githubActivity(activityId, 'search_code', {
        context: largeContext,
        sources: 'available',
         sourceCards: [githubSource(activityId, index + 1)]
      });
    })
  };
  assert.ok(utf8Bytes(fixture) > MAX_BYTES);
  const compacted = contract.compactReceiptSet(fixture, { profile: PROFILE });
  assert.ok(utf8Bytes(compacted) <= MAX_BYTES);
  assert.equal(compacted.omitted, true);
  assert.equal(compacted.omittedSources, 0);
  assert.equal(compacted.activities.every(item => item.context === undefined), true);
  assert.equal(compacted.activities.every(item => item.sourceCards.length === 1), true);
});

test('adds only the real source omission count to an existing omission count', () => {
  const fixture = largeMixedFixture();
  fixture.omitted = true;
  fixture.omittedSources = 7;
  const compacted = contract.compactReceiptSet(fixture, { profile: PROFILE });
  const allSources = fixture.activities.reduce((total, item) => total + item.sourceCards.length, 0);
  const keptSources = compacted.activities.reduce((total, item) => total + item.sourceCards.length, 0);
  assert.equal(compacted.omittedSources, 7 + allSources - keptSources);
});

test('exports the same interface to a browser global without dependencies', () => {
  const sourcePath = path.join(__dirname, '..', 'public', 'js', 'codex-receipt-contract.js');
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath });
  assert.equal(sandbox.CodexReceiptContract.PROFILE, PROFILE);
  assert.equal(typeof sandbox.CodexReceiptContract.normalizeReceiptSet, 'function');
  assert.equal(typeof sandbox.CodexReceiptContract.compactReceiptSet, 'function');
});
