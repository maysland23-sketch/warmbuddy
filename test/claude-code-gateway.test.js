const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentGatewayClient } = require('../claude-code-gateway');

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

test('run posts the fixed project and parses the Gateway SSE stream', async () => {
  let request;
  const events = [];
  let heartbeatCount = 0;
  const client = createAgentGatewayClient({
    baseUrl: 'https://gateway.test/',
    token: 'secret',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return sseResponse([
        'event: start\ndata: {"sessionId":"s1"}\n\n',
        ': heartbeat\n\n',
        'event: delta\ndata: {"text":"Hel"}\n',
        '\nevent: delta\ndata: {"text":"lo"}\n\n',
        'event: result\ndata: {"text":"Hello","sessionId":"s1"}\n\n',
        'event: done\ndata: {}\n\n'
      ]);
    }
  });

  const result = await client.run({
    conversationId: 'c1',
    prompt: 'hello',
    onEvent: event => events.push(event),
    onHeartbeat: () => { heartbeatCount += 1; }
  });

  assert.equal(result.content, 'Hello');
  assert.equal(request.url, 'https://gateway.test/v1/agent/stream');
  assert.equal(request.options.headers.authorization, 'Bearer secret');
  assert.deepEqual(request.body, {
    projectId: 'warmbuddy-test',
    conversationId: 'c1',
    prompt: 'hello',
    resume: false
  });
  assert.deepEqual(events.map(event => event.type), ['start', 'delta', 'delta', 'result', 'done']);
  assert.deepEqual(events.filter(event => event.text).map(event => event.text), ['Hel', 'lo', 'Hello']);
  assert.equal(heartbeatCount, 1);
});

test('run converts an upstream error event into a typed error', async () => {
  const client = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    fetchImpl: async () => sseResponse([
      'event: error\ndata: {"error":"Gateway rejected","code":"PROJECT_NOT_ALLOWED"}\n\n'
    ])
  });

  await assert.rejects(() => client.run({ conversationId: 'c1', prompt: 'hello' }), error => {
    assert.equal(error.name, 'AgentGatewayError');
    assert.equal(error.status, 502);
    assert.equal(error.code, 'PROJECT_NOT_ALLOWED');
    assert.equal(error.message, 'Gateway rejected');
    return true;
  });
});

test('run converts Gateway failure and timeout into typed errors', async () => {
  const logs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logs.push(args);
  const failed = createAgentGatewayClient({
    baseUrl: 'http://gateway.test',
    token: 'secret',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'denied', code: 'PROJECT_NOT_ALLOWED' }), {
      status: 403,
      statusText: 'Forbidden'
    })
  });
  try {
    await assert.rejects(() => failed.run({ conversationId: 'c1', prompt: 'hello' }), error => {
      assert.equal(error.name, 'AgentGatewayError');
      assert.equal(error.status, 403);
      assert.equal(error.code, 'PROJECT_NOT_ALLOWED');
      return true;
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], '[agent-gateway] upstream non-2xx response');
  assert.deepEqual(logs[0][1], {
    status: 403,
    statusText: 'Forbidden',
    body: '{"error":"denied","code":"PROJECT_NOT_ALLOWED"}',
    AGENT_GATEWAY_URL: 'http://gateway.test',
    projectId: 'warmbuddy-test'
  });
  assert.doesNotMatch(JSON.stringify(logs), /Authorization|Bearer|secret|AGENT_GATEWAY_TOKEN/);

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
