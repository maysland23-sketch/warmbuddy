const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.NODE_ENV = 'test';

const app = require('../server');
const { AgentGatewayError } = require('../claude-code-gateway');

function startApi() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopApi(server) {
  return new Promise(resolve => server.close(resolve));
}

test('agent stream forwards canonical context and streams Gateway deltas to WarmBuddy SSE', async () => {
  const calls = [];
  app.locals.agentGatewayClient = {
    run: async ({ onEvent, onHeartbeat, ...request }) => {
      calls.push(request);
      onHeartbeat();
      onEvent({ type: 'delta', text: 'Gateway ' });
      onEvent({ type: 'delta', text: 'reply' });
      onEvent({ type: 'result', text: 'Gateway reply' });
      onEvent({ type: 'done' });
      return { content: 'Gateway reply', sessionId: null, usage: null, resumed: false };
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'claude-code-test',
        windowId: 'chat-1',
        interactionId: 'i1',
        messages: [
          { role: 'system', content: 'SYSTEM' },
          { role: 'user', content: 'hello' }
        ]
      })
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].conversationId, 'chat-1');
    assert.match(calls[0].prompt, /CURRENT USER MESSAGE:/);
    assert.match(calls[0].prompt, /reading_import_book/);
    assert.match(calls[0].prompt, /~\/neverland\/books\//);
    assert.match(calls[0].prompt, /hello/);
    assert.match(text, /^: connected\n\n/);
    assert.match(text, /: heartbeat\n\n/);
    assert.doesNotMatch(text, /data: {"text":"heartbeat"}/);
    assert.match(text, /data: {"text":"Gateway "}/);
    assert.match(text, /data: {"text":"reply"}/);
    assert.equal((text.match(/data: {"text":"Gateway reply"}/g) || []).length, 0);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /secret|Bearer/);
  } finally {
    delete app.locals.agentGatewayClient;
    await stopApi(api);
  }
});

test('agent stream writes the first Gateway delta before run resolves', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  app.locals.agentGatewayClient = {
    run: async ({ onEvent }) => {
      onEvent({ type: 'delta', text: 'first' });
      await waiting;
      onEvent({ type: 'delta', text: 'second' });
      onEvent({ type: 'done' });
      return { content: 'firstsecond' };
    }
  };
  const api = await startApi();
  let response;
  let responsePromise;

  try {
    responsePromise = fetch(`http://127.0.0.1:${api.address().port}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'claude-code-test',
        windowId: 'chat-1',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    response = await Promise.race([
      responsePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not start')), 100))
    ]);
    assert.equal(response.headers.get('content-length'), null);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    release();
    const text = await response.text();
    assert.match(text, /data: {"text":"first"}/);
    assert.match(text, /data: {"text":"second"}/);
  } finally {
    release();
    await responsePromise?.catch(() => {});
    delete app.locals.agentGatewayClient;
    await stopApi(api);
  }
});

test('agent stream rejects other projects before calling Gateway', async () => {
  let called = false;
  app.locals.agentGatewayClient = {
    run: async () => {
      called = true;
      return { content: 'unexpected' };
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'reading',
        windowId: 'chat-1',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /claude-code-test/);
    assert.equal(called, false);
  } finally {
    delete app.locals.agentGatewayClient;
    await stopApi(api);
  }
});

test('agent stream emits structured Gateway errors without returning credentials', async () => {
  app.locals.agentGatewayClient = {
    run: async () => {
      throw new AgentGatewayError('Gateway unavailable', {
        status: 504,
        code: 'AGENT_GATEWAY_TIMEOUT'
      });
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/agent/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'claude-code-test',
        windowId: 'chat-1',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /AGENT_GATEWAY_TIMEOUT/);
    assert.match(body, /data: {"error":"Gateway unavailable","code":"AGENT_GATEWAY_TIMEOUT"}/);
    assert.match(body, /data: \[DONE\]/);
    assert.doesNotMatch(body, /Bearer|AGENT_GATEWAY_TOKEN|secret/);
  } finally {
    delete app.locals.agentGatewayClient;
    await stopApi(api);
  }
});
