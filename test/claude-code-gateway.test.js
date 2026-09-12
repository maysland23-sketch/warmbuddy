const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentGatewayClient } = require('../claude-code-gateway');

test('run posts the fixed project and isolated-run contract', async () => {
  let request;
  const client = createAgentGatewayClient({
    baseUrl: 'https://gateway.test/',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ ok: true, result: 'done', sessionId: null, resumed: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  const result = await client.run({ conversationId: 'c1', prompt: 'hello' });

  assert.equal(result.content, 'done');
  assert.equal(request.url, 'https://gateway.test/v1/agent/run');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.deepEqual(request.body, {
    projectId: 'warmbuddy-test',
    conversationId: 'c1',
    prompt: 'hello',
    resume: false
  });
});

test('run converts Gateway failure and timeout into typed errors', async () => {
  const failed = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'denied', code: 'PROJECT_NOT_ALLOWED' }), { status: 403 })
  });
  await assert.rejects(() => failed.run({ conversationId: 'c1', prompt: 'hello' }), error => {
    assert.equal(error.name, 'AgentGatewayError');
    assert.equal(error.status, 403);
    assert.equal(error.code, 'PROJECT_NOT_ALLOWED');
    return true;
  });

  const timedOut = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })
  });
  await assert.rejects(() => timedOut.run({ conversationId: 'c1', prompt: 'hello' }), error => error.code === 'AGENT_GATEWAY_TIMEOUT');
});
