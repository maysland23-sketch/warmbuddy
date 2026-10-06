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
