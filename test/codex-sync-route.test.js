const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';

const app = require('../server');

let server;
let origin;

test.before(async () => {
  server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

const headers = {
  'content-type': 'application/json',
  'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeGithubReceipts() {
  return { activities: [{
    requestId: 'wr_123e4567-e89b-12d3-a456-426614174000', activityId: 'wa_1',
    tool: 'github_mcp', phase: 'completed', action: 'search_code', outcome: 'unknown',
    sources: 'none', sourceCards: []
  }] };
}

function makeStartedWebReceipts(action = 'unknown', phase = 'started') {
  return { activities: [Object.assign({
    requestId: 'wr_123e4567-e89b-12d3-a456-426614174000', activityId: 'wa_1',
    tool: 'web_search', phase, action, outcome: 'unknown', sourceCards: []
  }, phase === 'completed' ? { sources: 'none' } : {})] };
}

function makeGithubFailedReceipts() {
  const receipts = makeGithubReceipts();
  receipts.activities[0].outcome = 'failed';
  receipts.activities[0].reason = 'tool_failed';
  return receipts;
}

function makeGithubReceiptsWithSource() {
  const receipts = makeGithubReceipts();
  receipts.activities[0].sources = 'available';
  receipts.activities[0].sourceCards = [{
    requestId: receipts.activities[0].requestId, activityId: 'wa_1',
    sourceId: 'ws_' + 'a'.repeat(64),
    displayUrl: 'https://github.com/neverland/warmbuddy/blob/main/README.md',
    url: 'https://github.com/neverland/warmbuddy/blob/main/README.md',
    redacted: false, linkKind: 'constructed'
  }];
  return receipts;
}

function makeCodexRow(id, overrides = {}) {
  return {
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: id, role: 'user',
    content: 'existing', token_usage: 0, created_at: '2026-10-06T00:00:00.000Z',
    metadata: {
      runtime: 'codex-gateway', turnId: 'turn-' + id, turnStatus: 'completed', messageIndex: 0,
      version: 1, writerId: 'writer-existing', updatedAt: '2026-10-06T00:00:01.000Z'
    },
    ...overrides
  };
}

function makeGithubRow(id, overrides = {}) {
  const baseMetadata = makeCodexRow(id).metadata;
  const row = makeCodexRow(id, overrides);
  row.metadata = {
    ...baseMetadata, ...row.metadata, receiptProfile: 'github-mcp-v1', receipts: makeGithubReceipts(), ...overrides.metadata
  };
  return row;
}

function makeIncomingMessage(id, metadata = {}, overrides = {}) {
  return {
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: id, role: 'user',
    content: 'incoming', token_usage: 0, created_at: '2026-10-06T00:00:00.000Z',
    metadata: {
      runtime: 'codex-gateway', turnId: 'turn-' + id, turnStatus: 'completed', messageIndex: 0,
      version: 2, writerId: 'writer-incoming', updatedAt: '2026-10-06T00:00:02.000Z', ...metadata
    },
    ...overrides
  };
}

function makeGenericMessage(id, overrides = {}) {
  return {
    project_id: 'ordinary-project', window_id: 'chat-1', message_id: id, role: 'user',
    content: 'ordinary incoming', token_usage: 0, created_at: '2026-10-06T00:00:00.000Z',
    metadata: { contentType: 'plain-text' },
    ...overrides
  };
}

function makeFakeDatabase(initialRows = [], options = {}) {
  const rows = initialRows.map(clone);
  const tableRows = {
    chat_messages: rows,
    system_events: (options.systemEvents || []).map(clone),
    project_configs: (options.projectConfigs || []).map(clone)
  };
  let readCount = 0;
  let selectCount = 0;
  let writeCount = 0;
  const matches = (row, filters) => filters.every(([field, value]) => {
    if (field === 'metadata') return JSON.stringify(row.metadata) === String(value);
    return row[field] === value;
  });
  const contains = (row, filters) => filters.every(([field, value]) => {
    const actual = row[field];
    return actual && typeof actual === 'object' && Object.keys(value).every(key => actual[key] === value[key]);
  });
  const executeSelect = chain => {
    if (options.selectError) return { data: null, error: options.selectError };
    const sourceRows = tableRows[chain.table] || rows;
    let selected = sourceRows.filter(row => matches(row, chain.filters) && contains(row, chain.containsFilters));
    for (const order of [...chain.orders].reverse()) {
      selected = selected.slice().sort((left, right) => String(left[order.field]).localeCompare(String(right[order.field])) * (order.ascending ? 1 : -1));
    }
    if (chain.rangeArgs) selected = selected.slice(chain.rangeArgs[0], chain.rangeArgs[1] + 1);
    if (chain.limitCount !== null) selected = selected.slice(0, chain.limitCount);
    return { data: selected.map(clone), error: null };
  };
  const database = {
    rows,
    get readCount() { return readCount; },
    get writeCount() { return writeCount; },
    from(table = 'chat_messages') {
      const chain = {
        table, mode: 'select', payload: null, filters: [], containsFilters: [], orders: [], rangeArgs: null, limitCount: null,
        select() { return this; },
        eq(field, value) { this.filters.push([field, value]); return this; },
        contains(field, value) { this.containsFilters.push([field, value]); return this; },
        order(field, options = {}) { this.orders.push({ field, ascending: options.ascending !== false }); return this; },
        range(start, end) { this.rangeArgs = [start, end]; return this; },
        limit(count) { this.limitCount = count; return this; },
        update(payload) { this.mode = 'update'; this.payload = payload; return this; },
        delete() { this.mode = 'delete'; return this; },
        insert(payload) {
          writeCount++;
          const targetRows = tableRows[this.table] || rows;
          if (targetRows.some(row => row.message_id === payload.message_id)) return Promise.resolve({ error: { code: '23505' } });
          targetRows.push(clone(payload));
          if (options.afterInsert) options.afterInsert({ rows, payload });
          return Promise.resolve({ error: null });
        },
        async maybeSingle() {
          if (this.mode === 'update') {
            const targetRows = tableRows[this.table] || rows;
            const target = targetRows.find(row => matches(row, this.filters));
            if (!target) return { data: null, error: null };
            writeCount++;
            Object.assign(target, clone(this.payload));
            if (options.afterUpdate) options.afterUpdate({ rows, payload: this.payload });
            return { data: { message_id: target.message_id }, error: null };
          }
          if (this.mode === 'delete') {
            const targetRows = tableRows[this.table] || rows;
            const targetIndex = targetRows.findIndex(row => matches(row, this.filters));
            if (targetIndex < 0) return { data: null, error: null };
            const [target] = targetRows.splice(targetIndex, 1);
            writeCount++;
            if (options.afterDelete) options.afterDelete({ rows, target });
            return { data: { message_id: target.message_id }, error: null };
          }
          readCount++;
          const result = executeSelect(this);
          const data = result.data && result.data.length ? result.data[0] : null;
          if (options.afterMaybeSingle) options.afterMaybeSingle({ readCount, rows, data });
          return { data, error: result.error };
        },
        then(resolve, reject) {
          selectCount++;
          if (options.afterSelect) options.afterSelect({ selectCount, rows });
          return Promise.resolve(executeSelect(this)).then(resolve, reject);
        }
      };
      return chain;
    }
  };
  return database;
}

test('generic chat sync preserves ordinary messages and rejects protected collisions before writing', async () => {
  const ordinaryId = 'generic-ordinary';
  const ordinaryDatabase = makeFakeDatabase([]);
  app.locals.chatMessagesSupabase = ordinaryDatabase;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(ordinaryId)] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { synced: 1 });
    assert.equal(ordinaryDatabase.rows[0].message_id, ordinaryId);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }

  const protectedId = 'generic-protected-collision';
  const protectedDatabase = makeFakeDatabase([makeGithubRow(protectedId)]);
  const before = clone(protectedDatabase.rows);
  app.locals.chatMessagesSupabase = protectedDatabase;
  try {
    const spoofedProject = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(protectedId, { project_id: 'spoofed-project' })] })
    });
    assert.equal(spoofedProject.status, 409);
    assert.deepEqual(await spoofedProject.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(protectedDatabase.writeCount, 0);
    assert.deepEqual(protectedDatabase.rows, before);

    const removedProfile = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(protectedId, {
        project_id: 'codex-code-test', metadata: { contentType: 'plain-text' }
      })] })
    });
    assert.equal(removedProfile.status, 409);
    assert.equal(protectedDatabase.writeCount, 0);
    assert.deepEqual(protectedDatabase.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync rejects protected creations and mixed batches in static preflight', async () => {
  const database = makeFakeDatabase([makeGithubRow('mixed-protected')]);
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const protectedCreation = makeGenericMessage('generic-profile-create', {
      metadata: { receiptProfile: 'github-mcp-v1', receipts: { activities: [] } }
    });
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage('mixed-ordinary'), protectedCreation] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync rejects new Codex-project rows and runtime spoofing', async () => {
  const database = makeFakeDatabase([]);
  app.locals.chatMessagesSupabase = database;
  try {
    const codexProject = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage('generic-codex-new', {
        project_id: 'codex-code-test'
      })] })
    });
    assert.equal(codexProject.status, 409);
    assert.deepEqual(await codexProject.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, []);

    const runtimeSpoof = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage('generic-runtime-spoof', {
        metadata: { runtime: 'codex-gateway' }
      })] })
    });
    assert.equal(runtimeSpoof.status, 409);
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, []);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync rejects Codex-project migrations in both directions', async () => {
  const toCodexId = 'generic-migrate-to-codex';
  const toOrdinaryId = 'generic-migrate-from-codex';
  const database = makeFakeDatabase([
    makeGenericMessage(toCodexId),
    makeCodexRow(toOrdinaryId)
  ]);
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [
        makeGenericMessage(toCodexId, { project_id: 'codex-code-test' }),
        makeGenericMessage(toOrdinaryId, { project_id: 'ordinary-project', metadata: { contentType: 'plain-text' } })
      ] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync preflight rejects a mixed ordinary and Codex-project batch before any write', async () => {
  const database = makeFakeDatabase([]);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [
        makeGenericMessage('generic-boundary-mixed-ordinary'),
        makeGenericMessage('generic-boundary-mixed-codex', { project_id: 'codex-code-test' })
      ] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, []);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync rechecks project ownership after the static preflight', async () => {
  const id = 'generic-project-boundary-race';
  const database = makeFakeDatabase([makeGenericMessage(id)], {
    afterMaybeSingle({ readCount, rows }) {
      if (readCount === 1) rows[0].project_id = 'codex-code-test';
    }
  });
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(id, { content: 'boundary race' })] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].project_id, 'codex-code-test');
    assert.equal(database.rows[0].content, before[0].content);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('proactive backfill does not create ordinary rows in the Codex project without an ID collision', async () => {
  const database = makeFakeDatabase([], {
    systemEvents: [{
      id: 'backfill-codex-project-event', project_id: 'codex-code-test', chat_id: 'chat-1', type: 'message',
      content: 'must not be mirrored', created_at: '2026-10-06T00:00:00.000Z'
    }]
  });
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/chat-messages?projectId=codex-code-test&targetWindowId=chat-1`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messages: [] });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, []);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('token log mirror does not create an ordinary row in the Codex project without an ID collision', async () => {
  const database = makeFakeDatabase([]);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/log-token-call`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'codex-code-test', windowId: 'chat-1', interactionId: 'boundary-new' })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false, error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, []);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync repeats the protected check after a concurrent row change', async () => {
  const id = 'generic-write-race';
  const database = makeFakeDatabase([makeGenericMessage(id)], {
    afterMaybeSingle({ readCount, rows }) {
      if (readCount === 1) rows[0].metadata = makeGithubRow(id).metadata;
    }
  });
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(id, { content: 'race update' })] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, [{ ...before[0], metadata: makeGithubRow(id).metadata }]);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic chat sync reports partial confirmation after a later protected race', async () => {
  const firstId = 'generic-partial-first';
  const secondId = 'generic-partial-second';
  const database = makeFakeDatabase([], {
    afterInsert({ rows, payload }) {
      if (payload.message_id === firstId) rows.push(makeGithubRow(secondId));
    }
  });
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeGenericMessage(firstId), makeGenericMessage(secondId)] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT',
      synced: 1, syncedMessageIds: [firstId], partial: true
    });
    assert.equal(database.rows.some(row => row.message_id === firstId), true);
    assert.equal(database.rows.find(row => row.message_id === secondId).metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('generic delete preserves ordinary behavior and rejects protected rows including a delete race', async () => {
  const ordinaryId = 'generic-delete-ordinary';
  const ordinaryDatabase = makeFakeDatabase([makeGenericMessage(ordinaryId)]);
  app.locals.chatMessagesSupabase = ordinaryDatabase;
  try {
    const response = await fetch(`${origin}/api/delete-message`, {
      method: 'POST', headers, body: JSON.stringify({ messageId: ordinaryId })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(ordinaryDatabase.rows.length, 0);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }

  const codexE1AId = 'generic-delete-codex-e1a';
  const codexE1ADatabase = makeFakeDatabase([makeCodexRow(codexE1AId)]);
  app.locals.chatMessagesSupabase = codexE1ADatabase;
  try {
    const response = await fetch(`${origin}/api/delete-message`, {
      method: 'POST', headers, body: JSON.stringify({ messageId: codexE1AId })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(codexE1ADatabase.rows.length, 0);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }

  const protectedId = 'generic-delete-protected';
  const protectedDatabase = makeFakeDatabase([makeGithubRow(protectedId)]);
  const before = clone(protectedDatabase.rows);
  app.locals.chatMessagesSupabase = protectedDatabase;
  try {
    const response = await fetch(`${origin}/api/delete-message`, {
      method: 'POST', headers, body: JSON.stringify({ messageId: protectedId })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.deepEqual(protectedDatabase.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }

  const raceId = 'generic-delete-race';
  const raceDatabase = makeFakeDatabase([makeGenericMessage(raceId)], {
    afterMaybeSingle({ readCount, rows }) {
      if (readCount === 1) rows[0].metadata = makeGithubRow(raceId).metadata;
    }
  });
  app.locals.chatMessagesSupabase = raceDatabase;
  try {
    const response = await fetch(`${origin}/api/delete-message`, {
      method: 'POST', headers, body: JSON.stringify({ messageId: raceId })
    });
    assert.equal(response.status, 409);
    assert.equal(raceDatabase.rows.length, 1);
    assert.equal(raceDatabase.rows[0].metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('chat-message read backfill cannot overwrite a protected row on a proactive ID collision', async () => {
  const collisionId = 'proactive_evt_backfill-event_chat-1';
  const database = makeFakeDatabase([makeGithubRow(collisionId)], {
    systemEvents: [{
      id: 'backfill-event', project_id: 'codex-code-test', chat_id: 'chat-1', type: 'message',
      content: 'backfill content', created_at: '2026-10-06T00:00:00.000Z'
    }]
  });
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/chat-messages?projectId=codex-code-test&targetWindowId=chat-1`, { headers });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messages: [] });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('token log chat row cannot overwrite an existing protected message ID', async () => {
  const id = 'tok_token-collision_single';
  const database = makeFakeDatabase([makeGithubRow(id)]);
  const before = clone(database.rows);
  app.locals.chatMessagesSupabase = database;
  try {
    const response = await fetch(`${origin}/api/log-token-call`, {
      method: 'POST', headers,
      body: JSON.stringify({ projectId: 'codex-code-test', windowId: 'chat-1', interactionId: 'token-collision' })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false, error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.deepEqual(database.rows, before);
  } finally {
    delete app.locals.chatMessagesSupabase;
  }
});

test('Codex sync route stays behind the Render guard and rejects other projects', async () => {
  const unauthorized = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${origin}/api/codex/sync-messages`, {
    method: 'POST', headers,
    body: JSON.stringify({ messages: [{ project_id: 'other-project' }] })
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'CODEX_SYNC_INVALID_REQUEST', code: 'CODEX_SYNC_INVALID_REQUEST'
  });
});

test('Codex conversation read is exact-project scoped and has no session sidecar', async () => {
  const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&limit=100`, {
    headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { messages: [], nextCursor: null });
  assert.doesNotMatch(JSON.stringify(body), /sessionId|gatewayUrl|token/i);
});

test('Codex conversation read requires the profile before exposing a protected project', async () => {
  const database = makeFakeDatabase([makeGithubRow('protected-read')]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&limit=100`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED'
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex conversation read rejects an unknown profile before querying', async () => {
  const database = makeFakeDatabase([makeGithubRow('protected-read-unknown')]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&receiptProfile=github-mcp-v2`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED', code: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED'
    });
    assert.equal(database.readCount, 0);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex conversation read with the fixed profile returns mixed E1-A and GitHub rows', async () => {
  const database = makeFakeDatabase([
    makeCodexRow('web-read'),
    makeGithubRow('github-read')
  ]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&receiptProfile=github-mcp-v1&limit=100`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.messages.map(row => row.messageId), ['github-read', 'web-read'].sort());
    assert.equal(body.messages.find(row => row.messageId === 'github-read').metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex old conversation read remains compatible for an unprotected E1-A project', async () => {
  const database = makeFakeDatabase([makeCodexRow('legacy-web-read')]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&limit=100`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.messages.map(row => row.messageId), ['legacy-web-read']);
    assert.equal(body.messages[0].metadata.receiptProfile, undefined);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex old conversation read rechecks fetched rows after preflight and does not leak a new protected row', async () => {
  const database = makeFakeDatabase([makeCodexRow('web-before-race')], {
    afterSelect({ selectCount, rows }) {
      if (selectCount === 1) rows.push(makeGithubRow('github-after-preflight'));
    }
  });
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test&limit=100`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED'
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex conversation read turns a protection preflight database failure into a controlled error', async () => {
  app.locals.codexSupabase = makeFakeDatabase([], { selectError: { code: 'DB_READ_FAILED' } });
  try {
    const response = await fetch(`${origin}/api/codex/conversation-messages?projectId=codex-code-test`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_SYNC_UNAVAILABLE', code: 'CODEX_SYNC_UNAVAILABLE'
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rejects a missing or unsupported profile before writing', async () => {
  const database = makeFakeDatabase([]);
  app.locals.codexSupabase = database;
  const message = makeIncomingMessage('profile-required', {
    receiptProfile: 'github-mcp-v1', receipts: makeGithubReceipts()
  });
  try {
    const missing = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [message] })
    });
    assert.equal(missing.status, 428);
    assert.deepEqual(await missing.json(), {
      error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED'
    });
    assert.equal(database.writeCount, 0);

    const unsupported = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers, body: JSON.stringify({ receiptProfile: 'github-mcp-v2', messages: [message] })
    });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(await unsupported.json(), {
      error: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED', code: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED'
    });
    assert.equal(database.writeCount, 0);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rejects a higher-version protected-row downgrade before writing', async () => {
  const database = makeFakeDatabase([makeGithubRow('protected-write')]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage('protected-write')] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rejects same-count activity replacement and leaves the database unchanged', async () => {
  const cases = [
    {
      name: 'tool-replacement',
      existingReceipts: makeGithubReceipts(),
      incomingReceipts: Object.assign(clone(makeGithubReceipts()), {
        activities: [Object.assign(clone(makeGithubReceipts().activities[0]), {
          tool: 'web_search', action: 'search', outcome: 'unknown'
        })]
      })
    },
    {
      name: 'identity-replacement',
      existingReceipts: makeGithubReceipts(),
      incomingReceipts: Object.assign(clone(makeGithubReceipts()), {
        activities: [Object.assign(clone(makeGithubReceipts().activities[0]), { activityId: 'wa_9' })]
      })
    },
    {
      name: 'failure-erasure',
      existingReceipts: makeGithubFailedReceipts(),
      incomingReceipts: makeGithubReceipts()
    }
  ];
  for (const testCase of cases) {
    const id = 'same-count-' + testCase.name;
    const database = makeFakeDatabase([makeGithubRow(id, {
      metadata: { receipts: testCase.existingReceipts }
    })]);
    const before = clone(database.rows);
    app.locals.codexSupabase = database;
    try {
      const response = await fetch(`${origin}/api/codex/sync-messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(id, {
          receiptProfile: 'github-mcp-v1', receipts: testCase.incomingReceipts, version: 9
        })] })
      });
      assert.equal(response.status, 409, testCase.name);
      assert.deepEqual(await response.json(), {
        error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
      });
      assert.equal(database.writeCount, 0, testCase.name);
      assert.deepEqual(database.rows, before, testCase.name);
    } finally {
      delete app.locals.codexSupabase;
    }
  }
});

test('Codex upload allows unknown started web actions to settle once and protects action bindings', async () => {
  for (const action of ['search', 'open_page']) {
    const id = 'web-action-compatible-' + action;
    const database = makeFakeDatabase([makeGithubRow(id, {
      metadata: {
        receipts: makeStartedWebReceipts()
      }
    })]);
    app.locals.codexSupabase = database;
    try {
      const response = await fetch(`${origin}/api/codex/sync-messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(id, {
          receiptProfile: 'github-mcp-v1', receipts: makeStartedWebReceipts(action, 'completed'), version: 9
        })] })
      });
      assert.equal(response.status, 200, action);
      assert.deepEqual((await response.json()).syncedMessageIds, [id]);
      assert.equal(database.rows[0].metadata.receipts.activities[0].action, action);
    } finally {
      delete app.locals.codexSupabase;
    }
  }

  const cases = [
    {
      name: 'known-action-switch',
      existingReceipts: makeStartedWebReceipts('search'),
      incomingReceipts: makeStartedWebReceipts('open_page', 'completed')
    },
    {
      name: 'terminal-action-switch',
      existingReceipts: makeStartedWebReceipts('search', 'completed'),
      incomingReceipts: makeStartedWebReceipts('open_page', 'completed')
    },
    {
      name: 'github-action-switch',
      existingReceipts: makeGithubReceipts(),
      incomingReceipts: Object.assign(clone(makeGithubReceipts()), {
        activities: [Object.assign(clone(makeGithubReceipts().activities[0]), { action: 'list_commits' })]
      })
    }
  ];
  for (const testCase of cases) {
    const id = 'web-action-protected-' + testCase.name;
    const database = makeFakeDatabase([makeGithubRow(id, {
      metadata: { receipts: testCase.existingReceipts }
    })]);
    const before = clone(database.rows);
    app.locals.codexSupabase = database;
    try {
      const response = await fetch(`${origin}/api/codex/sync-messages`, {
        method: 'POST', headers,
        body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(id, {
          receiptProfile: 'github-mcp-v1', receipts: testCase.incomingReceipts, version: 9
        })] })
      });
      assert.equal(response.status, 409, testCase.name);
      assert.deepEqual(await response.json(), {
        error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
      });
      assert.equal(database.writeCount, 0, testCase.name);
      assert.deepEqual(database.rows, before, testCase.name);
    } finally {
      delete app.locals.codexSupabase;
    }
  }
});

test('Codex upload rejects source deletion without omission but accepts late sources and compact summaries', async () => {
  const id = 'source-guard';
  const existingReceipts = makeGithubReceiptsWithSource();
  const database = makeFakeDatabase([makeGithubRow(id, { metadata: { receipts: existingReceipts } })]);
  app.locals.codexSupabase = database;
  try {
    const deleted = clone(existingReceipts);
    deleted.activities[0].sources = 'none';
    deleted.activities[0].sourceCards = [];
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(id, {
        receiptProfile: 'github-mcp-v1', receipts: deleted, version: 9
      })] })
    });
    assert.equal(response.status, 409);
    assert.equal(database.writeCount, 0);
  } finally {
    delete app.locals.codexSupabase;
  }

  const compactId = 'source-compact';
  const compactDatabase = makeFakeDatabase([makeGithubRow(compactId, { metadata: { receipts: existingReceipts } })]);
  app.locals.codexSupabase = compactDatabase;
  try {
    const compacted = clone(existingReceipts);
    compacted.omitted = true;
    compacted.omittedSources = 1;
    compacted.activities[0].sourceCards = [];
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(compactId, {
        receiptProfile: 'github-mcp-v1', receipts: compacted, version: 9
      })] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).syncedMessageIds, [compactId]);
    assert.equal(compactDatabase.rows[0].metadata.receipts.omittedSources, 1);
    assert.equal(compactDatabase.rows[0].metadata.receipts.activities[0].sourceCards.length, 0);
  } finally {
    delete app.locals.codexSupabase;
  }

  const lateId = 'source-late';
  const lateDatabase = makeFakeDatabase([makeGithubRow(lateId)]);
  app.locals.codexSupabase = lateDatabase;
  try {
    const late = makeGithubReceiptsWithSource();
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage(lateId, {
        receiptProfile: 'github-mcp-v1', receipts: late, version: 9
      })] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).syncedMessageIds, [lateId]);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload requires a profile before an old request can update a protected row', async () => {
  const database = makeFakeDatabase([makeGithubRow('protected-old-upload')]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeIncomingMessage('protected-old-upload')] })
    });
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload keeps an old web-only request compatible when no protected row exists', async () => {
  const database = makeFakeDatabase([]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ messages: [makeIncomingMessage('legacy-web-upload', {
        turnStatus: 'completed'
      })] })
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).syncedMessageIds, ['legacy-web-upload']);
    assert.equal(database.rows[0].metadata.receiptProfile, undefined);
    assert.equal(database.rows[0].metadata.receipts, undefined);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rejects a protected activity-set reduction even with a higher version', async () => {
  const existing = makeGithubRow('protected-reduction');
  existing.metadata.receipts.activities.push({
    ...existing.metadata.receipts.activities[0], activityId: 'wa_2', action: 'list_commits'
  });
  const database = makeFakeDatabase([existing]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage('protected-reduction', {
        receiptProfile: 'github-mcp-v1', receipts: makeGithubReceipts(), version: 9
      })] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].metadata.receipts.activities.length, 2);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rechecks profile protection after a CAS conflict', async () => {
  const database = makeFakeDatabase([makeCodexRow('cas-protection')], {
    afterMaybeSingle({ readCount, rows }) {
      if (readCount === 2) {
        rows[0].metadata = { ...rows[0].metadata, receiptProfile: 'github-mcp-v1', receipts: makeGithubReceipts() };
      }
    }
  });
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers, body: JSON.stringify({ messages: [makeIncomingMessage('cas-protection')] })
    });
    assert.equal(response.status, 428);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED'
    });
    assert.equal(database.rows[0].metadata.receiptProfile, 'github-mcp-v1');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload repeats activity identity protection after a CAS row becomes protected', async () => {
  const database = makeFakeDatabase([makeCodexRow('cas-activity-guard')], {
    afterMaybeSingle({ readCount, rows }) {
      if (readCount === 2) {
        const receipts = makeGithubReceipts();
        receipts.activities[0].activityId = 'wa_2';
        rows[0].metadata = { ...rows[0].metadata, receiptProfile: 'github-mcp-v1', receipts };
      }
    }
  });
  app.locals.codexSupabase = database;
  try {
    const incomingReceipts = makeGithubReceipts();
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage('cas-activity-guard', {
        receiptProfile: 'github-mcp-v1', receipts: incomingReceipts
      })] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].metadata.receipts.activities[0].activityId, 'wa_2');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload rejects message_id ownership conflicts without writing', async () => {
  const database = makeFakeDatabase([makeCodexRow('wrong-owner', {
    project_id: 'other-project', window_id: 'other-window', metadata: {
      runtime: 'other-runtime', turnId: 'other-turn', turnStatus: 'completed', version: 1,
      updatedAt: '2026-10-06T00:00:01.000Z'
    }
  })]);
  app.locals.codexSupabase = database;
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [makeIncomingMessage('wrong-owner')] })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT', code: 'CODEX_RECEIPT_MESSAGE_OWNERSHIP_CONFLICT'
    });
    assert.equal(database.writeCount, 0);
    assert.equal(database.rows[0].project_id, 'other-project');
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload stores failed, canceled, and unknown profile-bearing user rows', async () => {
  const database = makeFakeDatabase([]);
  app.locals.codexSupabase = database;
  const messages = ['failed', 'canceled', 'unknown'].map((status, index) => makeIncomingMessage('terminal-' + status, {
    turnStatus: status, version: index + 1, receiptProfile: 'github-mcp-v1', receipts: { activities: [] }
  }));
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.syncedMessageIds.sort(), messages.map(message => message.message_id).sort());
    assert.equal(database.rows.length, 3);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload idempotently confirms an identical canonical snapshot without a second write', async () => {
  const database = makeFakeDatabase([]);
  app.locals.codexSupabase = database;
  const message = makeIncomingMessage('idempotent', {
    receiptProfile: 'github-mcp-v1', receipts: { activities: [] }
  });
  try {
    const request = () => fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages: [message] })
    });
    const first = await request();
    const firstBody = await first.json();
    const writesAfterFirst = database.writeCount;
    const second = await request();
    const secondBody = await second.json();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(firstBody.syncedMessageIds, ['idempotent']);
    assert.deepEqual(secondBody.syncedMessageIds, ['idempotent']);
    assert.equal(database.writeCount, writesAfterFirst);
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex upload reports partial confirmation when a later concurrent protection conflict occurs', async () => {
  const database = makeFakeDatabase([], {
    afterInsert({ rows, payload }) {
      if (payload.message_id === 'partial-first') rows.push(makeGithubRow('partial-second'));
    }
  });
  app.locals.codexSupabase = database;
  const messages = [makeIncomingMessage('partial-first'), makeIncomingMessage('partial-second')];
  try {
    const response = await fetch(`${origin}/api/codex/sync-messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ receiptProfile: 'github-mcp-v1', messages })
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'CODEX_RECEIPT_UPDATE_CONFLICT', code: 'CODEX_RECEIPT_UPDATE_CONFLICT',
      synced: 1, syncedMessageIds: ['partial-first'], partial: true
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});

test('Codex sync performs one concurrent same-version terminal write and confirms the duplicate idempotently', async () => {
  let row = {
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'race-1', role: 'assistant',
    content: 'running', token_usage: 0, created_at: '2026-10-06T00:00:00.000Z',
    metadata: { runtime: 'codex-gateway', turnId: 'race', turnStatus: 'running', messageIndex: 0,
      version: 1, writerId: 'writer-a', updatedAt: '2026-10-06T00:00:01.000Z' }
  };
  let reads = 0;
  let releaseReads;
  const readsReady = new Promise(resolve => { releaseReads = resolve; });
  const fakeDatabase = {
    from() {
      const chain = {
        mode: 'read', payload: null, filters: [],
        select() { return this; },
        eq(field, value) { this.filters.push([field, value]); return this; },
        update(payload) { this.mode = 'update'; this.payload = payload; return this; },
        insert(payload) {
          if (row) return Promise.resolve({ error: { code: '23505' } });
          row = JSON.parse(JSON.stringify(payload));
          return Promise.resolve({ error: null });
        },
        upsert(payload) {
          row = JSON.parse(JSON.stringify(payload));
          return Promise.resolve({ error: null });
        },
        async maybeSingle() {
          if (this.mode === 'update') {
            const expected = this.filters.find(entry => entry[0] === 'metadata');
            const expectedMetadata = expected && typeof expected[1] === 'string' ? JSON.parse(expected[1]) : expected && expected[1];
            const matches = expected && row && JSON.stringify(row.metadata) === JSON.stringify(expectedMetadata);
            if (!matches) return { data: null, error: null };
            row = JSON.parse(JSON.stringify(this.payload));
            return { data: { message_id: row.message_id }, error: null };
          }
          reads++;
          if (reads === 2) releaseReads();
          if (reads <= 2) await readsReady;
          return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
        }
      };
      return chain;
    }
  };
  app.locals.codexSupabase = fakeDatabase;
  const body = JSON.stringify({ messages: [{
    project_id: 'codex-code-test', window_id: 'chat-1', message_id: 'race-1', role: 'assistant',
    content: 'completed', token_usage: 0, created_at: '2026-10-06T00:00:00.000Z',
    metadata: { runtime: 'codex-gateway', turnId: 'race', turnStatus: 'completed', messageIndex: 0,
      version: 2, writerId: 'writer-b', updatedAt: '2026-10-06T00:00:02.000Z' }
  }] });
  try {
    const request = () => fetch(`${origin}/api/codex/sync-messages`, { method: 'POST', headers, body });
    const responses = await Promise.all([request(), request()]);
    const results = await Promise.all(responses.map(response => response.json()));
    assert.equal(results.filter(result => result.synced === 1).length, 2);
    assert.equal(results.filter(result => result.synced === 0).length, 0);
    assert.deepEqual(row.metadata, {
      runtime: 'codex-gateway', turnId: 'race', turnStatus: 'completed', messageIndex: 0,
      version: 2, writerId: 'writer-b', updatedAt: '2026-10-06T00:00:02.000Z'
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});
