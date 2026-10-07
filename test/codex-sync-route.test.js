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

test('Codex sync conditionally accepts only one of two concurrent same-version terminal writes', async () => {
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
    assert.equal(results.filter(result => result.synced === 1).length, 1);
    assert.equal(results.filter(result => result.synced === 0).length, 1);
    assert.deepEqual(row.metadata, {
      runtime: 'codex-gateway', turnId: 'race', turnStatus: 'completed', messageIndex: 0,
      version: 2, writerId: 'writer-b', updatedAt: '2026-10-06T00:00:02.000Z'
    });
  } finally {
    delete app.locals.codexSupabase;
  }
});
