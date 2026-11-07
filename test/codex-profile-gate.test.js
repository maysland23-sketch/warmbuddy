const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';
process.env.CODEX_E1B_ENABLED = 'true';

const app = require('../server');

const headers = {
  'content-type': 'application/json',
  'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET
};

function startApi() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopApi(server) {
  return new Promise(resolve => server.close(resolve));
}

test('enabled E1-B config is no-store and advertises only the fixed receipt profile', async () => {
  const api = await startApi();
  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/config`, {
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { webMode: 'legacy', receiptProfile: 'github-mcp-v1' });
  } finally {
    await stopApi(api);
  }
});

test('enabled E1-B stream gate rejects missing and unsupported profiles before execution or SSE headers', async () => {
  let calls = 0;
  app.locals.codexGatewayClient = { run: async () => { calls++; } };
  const api = await startApi();
  try {
    for (const item of [
      { body: { prompt: 'missing' }, status: 428, code: 'CODEX_RECEIPT_PROFILE_REQUIRED' },
      { body: { prompt: 'unsupported', receiptProfile: 'github-mcp-v2' }, status: 400, code: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED' }
    ]) {
      const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
        method: 'POST', headers, body: JSON.stringify(item.body)
      });
      assert.equal(response.status, item.status);
      assert.deepEqual(await response.json(), { error: item.code, code: item.code });
      assert.equal(response.headers.get('content-type').startsWith('text/event-stream'), false);
    }
    assert.equal(calls, 0);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('enabled E1-B stream passes the exact profile to Gateway execution', async () => {
  const calls = [];
  app.locals.codexGatewayClient = {
    run: async options => {
      calls.push(options);
      await options.onEvent({ type: 'session', payload: { sessionId: 'gs_' + 'a'.repeat(64) } });
      await options.onEvent({ type: 'completion', payload: { status: 'completed' } });
      return { completed: true, sessionId: 'gs_' + 'a'.repeat(64), messages: [] };
    }
  };
  const api = await startApi();
  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ prompt: 'profile', receiptProfile: 'github-mcp-v1' })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].receiptProfile, 'github-mcp-v1');
    assert.equal(calls[0].prompt, 'profile');
    assert.equal(calls[0].sessionId, undefined);
    assert.doesNotMatch(JSON.stringify(calls[0].prompt), /github-mcp-v1/);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('enabled E1-B stream still rejects arbitrary fields without execution', async () => {
  let calls = 0;
  app.locals.codexGatewayClient = { run: async () => { calls++; } };
  const api = await startApi();
  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST', headers,
      body: JSON.stringify({ prompt: 'profile', receiptProfile: 'github-mcp-v1', token: 'secret' })
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid Codex request', code: 'CODEX_INVALID_REQUEST' });
    assert.equal(calls, 0);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('enabled profile projects mixed GitHub receipts in legacy web mode without private fields', async () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const sourceId = 'ws_' + 'b'.repeat(64);
  const commit = 'c'.repeat(40);
  const sourceUrl = `https://github.com/Neverland/warmbuddy/blob/${commit}/README.md`;
  app.locals.codexWebMode = 'legacy';
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      await onEvent({ type: 'activity', payload: {
        requestId, activityId: 'wa_1', tool: 'github_mcp', phase: 'started',
        action: 'get_file_contents', outcome: 'unknown', privateResult: 'secret'
      } });
      await onEvent({ type: 'activity', payload: {
        requestId, activityId: 'wa_1', tool: 'github_mcp', phase: 'completed',
        action: 'get_file_contents', outcome: 'failed', sources: 'available', reason: 'tool_failed',
        context: { owner: 'Neverland', repo: 'warmbuddy', path: 'README.md', commit },
        privateResult: 'secret'
      } });
      await onEvent({ type: 'source', payload: {
        requestId, activityId: 'wa_1', sourceId, displayUrl: sourceUrl, url: sourceUrl,
        redacted: false, linkKind: 'constructed', title: 'README', resourceUri: 'secret://uri'
      } });
      await onEvent({ type: 'completion', payload: { status: 'completed' } });
      return { completed: true, sessionId: 'gs_' + 'b'.repeat(64), messages: [] };
    }
  };
  const api = await startApi();
  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'github', receiptProfile: 'github-mcp-v1' })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /"tool":"github_mcp"/);
    assert.match(text, /"reason":"tool_failed"/);
    assert.match(text, /"linkKind":"constructed"/);
    assert.match(text, /"context":\{"owner":"Neverland","repo":"warmbuddy","path":"README.md","commit":"c{40}"\}/);
    assert.doesNotMatch(text, /privateResult|resourceUri|secret/);
  } finally {
    delete app.locals.codexWebMode;
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('enabled stream rejects incompatible activity snapshots before projecting the terminal event', async () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  app.locals.codexWebMode = 'native';
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      await onEvent({ type: 'activity', payload: {
        requestId, activityId: 'wa_1', tool: 'web_search', phase: 'started', action: 'search', outcome: 'unknown'
      } });
      await onEvent({ type: 'activity', payload: {
        requestId, activityId: 'wa_1', tool: 'web_search', phase: 'completed', action: 'open_page', outcome: 'unknown', sources: 'none'
      } });
      return { completed: true, sessionId: 'gs_' + 'd'.repeat(64), messages: [] };
    }
  };
  const api = await startApi();
  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: 'invalid transition', receiptProfile: 'github-mcp-v1' })
    });
    const text = await response.text();
    const activityPayloads = [...text.matchAll(/event: activity\ndata: ([^\n]+)/g)].map(match => JSON.parse(match[1]));
    assert.equal(activityPayloads.length, 1);
    assert.deepEqual(activityPayloads[0], {
      requestId, activityId: 'wa_1', tool: 'web_search', phase: 'started', action: 'search', outcome: 'unknown'
    });
    assert.doesNotMatch(text, /"phase":"completed"/);
  } finally {
    delete app.locals.codexWebMode;
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('invalid E1-B startup values fail closed before the server starts', () => {
  const result = spawnSync(process.execPath, ['-e', "process.env.NODE_ENV='test'; process.env.RENDER_PROXY_SECRET='server-secret-at-least-32-bytes-long'; process.env.CODEX_E1B_ENABLED='yes'; require('./server');"], {
    cwd: require('node:process').cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', RENDER_PROXY_SECRET: 'server-secret-at-least-32-bytes-long', CODEX_E1B_ENABLED: 'yes' }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /CODEX_E1B_ENABLED/);
});
