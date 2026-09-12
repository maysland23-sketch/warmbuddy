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

test('agent stream forwards canonical context and adapts Gateway JSON to WarmBuddy SSE', async () => {
  const calls = [];
  app.locals.agentGatewayClient = {
    run: async request => {
      calls.push(request);
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
    assert.equal(calls.length, 1);
    assert.equal(calls[0].conversationId, 'chat-1');
    assert.match(calls[0].prompt, /CURRENT USER MESSAGE:/);
    assert.match(calls[0].prompt, /reading_import_book/);
    assert.match(calls[0].prompt, /~\/neverland\/books\//);
    assert.match(calls[0].prompt, /hello/);
    assert.match(text, /data: {"text":"Gateway reply"}/);
    assert.match(text, /data: \[DONE\]/);
    assert.doesNotMatch(text, /secret|Bearer/);
  } finally {
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

test('agent stream maps Gateway errors without returning credentials', async () => {
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
    assert.equal(response.status, 504);
    assert.match(body, /AGENT_GATEWAY_TIMEOUT/);
    assert.doesNotMatch(body, /Bearer|AGENT_GATEWAY_TOKEN|secret/);
  } finally {
    delete app.locals.agentGatewayClient;
    await stopApi(api);
  }
});
