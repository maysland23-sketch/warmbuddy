const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  CODEX_GATEWAY_TOKEN_PATTERN,
  CODEX_SESSION_ID_PATTERN,
  MAX_CODEX_BODY_BYTES,
  MAX_CODEX_GATEWAY_OUTPUT_BYTES,
  MAX_CODEX_MESSAGE_COUNT,
  MAX_CODEX_PROMPT_BYTES,
  MAX_CODEX_SSE_INPUT_BYTES,
  CodexGatewayError,
  createCodexGatewayClient,
  serializeCodexRequest
} = require('../codex-gateway');

const TEST_TOKEN = 'a'.repeat(64);

function sseResponse(text, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
}

function splitUtf8(text, size) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

function chunkedSseResponse(text, size) {
  const encoder = new TextEncoder();
  const chunks = splitUtf8(text, size);
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  });
}

function clientWithResponse(responseOrFactory, options = {}) {
  let calls = 0;
  const client = createCodexGatewayClient({
    baseUrl: 'http://127.0.0.1:43123',
    token: TEST_TOKEN,
    allowHttpLoopback: true,
    fetchImpl: async (_url, request) => {
      calls += 1;
      return typeof responseOrFactory === 'function' ? responseOrFactory(request) : responseOrFactory;
    },
    ...options
  });
  return { client, getCalls: () => calls };
}

test('Codex client sends only the allowed JSON fields and forwards complete messages in order', async () => {
  const sessionId = 'gs_' + 'a'.repeat(64);
  const upstream = [
    'event: session\ndata: {"sessionId":"' + sessionId + '","threadId":"private-thread"}\n\n',
    ': heartbeat\n\n',
    'event: status\ndata: {"status":"running","stderr":"private-stderr"}\n\n',
    'event: message\ndata: {"text":"第一条猫","threadId":"private-thread"}\n\n',
    'event: message\ndata: {"text":"第二条","stderr":"private-stderr"}\n\n',
    'event: completion\ndata: {"status":"completed","threadId":"private-thread"}\n\n'
  ].join('');
  let request;
  const { client, getCalls } = clientWithResponse((_request) => {
    request = _request;
    return chunkedSseResponse(upstream, 3);
  });
  const events = [];
  let heartbeats = 0;

  const result = await client.run({
    prompt: '读取书籍',
    sessionId,
    onEvent: event => events.push(event),
    onHeartbeat: () => { heartbeats += 1; }
  });

  assert.equal(getCalls(), 1);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.headers.authorization, `Bearer ${TEST_TOKEN}`);
  assert.deepEqual(Object.keys(JSON.parse(request.body)).sort(), ['prompt', 'sessionId']);
  assert.deepEqual(JSON.parse(request.body), { prompt: '读取书籍', sessionId });
  assert.equal(Buffer.byteLength(request.body, 'utf8') <= MAX_CODEX_BODY_BYTES, true);
  assert.deepEqual(events.map(event => event.type), ['session', 'status', 'message', 'message', 'completion']);
  assert.deepEqual(events.filter(event => event.type === 'message').map(event => event.text), ['第一条猫', '第二条']);
  assert.deepEqual(events.map(event => event.payload), [
    { sessionId },
    { status: 'running' },
    { text: '第一条猫' },
    { text: '第二条' },
    { status: 'completed' }
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private-thread|private-stderr/);
  assert.equal(heartbeats, 1);
  assert.deepEqual(result.messages, ['第一条猫', '第二条']);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.completed, true);
});

test('Codex client enforces UTF-8 prompt, NUL, session, and exact body validation', async () => {
  const { client } = clientWithResponse(sseResponse(''));
  const validSessionId = 'gs_' + 'f'.repeat(64);

  assert.equal(CODEX_SESSION_ID_PATTERN.test(validSessionId), true);
  assert.equal(CODEX_GATEWAY_TOKEN_PATTERN.test(TEST_TOKEN), true);
  assert.equal(MAX_CODEX_PROMPT_BYTES, 32768);
  assert.equal(MAX_CODEX_BODY_BYTES, 65536);
  const maxPrompt = '猫'.repeat(10922) + 'ab';
  assert.equal(Buffer.byteLength(maxPrompt, 'utf8'), MAX_CODEX_PROMPT_BYTES);
  assert.deepEqual(JSON.parse(serializeCodexRequest(maxPrompt)), { prompt: maxPrompt });
  assert.deepEqual(JSON.parse(serializeCodexRequest('hello')), { prompt: 'hello' });
  assert.deepEqual(JSON.parse(serializeCodexRequest('hello', validSessionId)), { prompt: 'hello', sessionId: validSessionId });

  await assert.rejects(() => client.run({ prompt: ' \n\t' }), error => error.code === 'CODEX_INVALID_PROMPT');
  await assert.rejects(() => client.run({ prompt: 'safe\0text' }), error => error.code === 'CODEX_INVALID_PROMPT');
  await assert.rejects(() => client.run({ prompt: '猫'.repeat(10923) }), error => error.code === 'CODEX_PROMPT_TOO_LARGE');
  await assert.rejects(() => client.run({ prompt: 'hello', sessionId: 'thread-1' }), error => error.code === 'CODEX_INVALID_SESSION');
  await assert.rejects(() => client.run({ prompt: 'hello', sessionId: 'gs_' + 'A'.repeat(64) }), error => error.code === 'CODEX_INVALID_SESSION');
  await assert.rejects(() => client.run({ prompt: 'hello', sessionId: null }), error => error.code === 'CODEX_INVALID_SESSION');
});

test('Codex client rejects incomplete, failed, and invalid streams without replaying POST', async () => {
  const cases = [
    ['missing completion', 'event: message\ndata: {"text":"partial"}\n\n', 'CODEX_GATEWAY_INCOMPLETE'],
    ['failed completion', 'event: completion\ndata: {"status":"failed"}\n\n', 'CODEX_GATEWAY_FAILED'],
    ['unknown event', 'event: delta\ndata: {"text":"wrong"}\n\n', 'CODEX_GATEWAY_INVALID_RESPONSE'],
    ['unterminated completion', 'event: completion\ndata: {"status":"completed"}\n', 'CODEX_GATEWAY_INVALID_RESPONSE'],
    ['truncated json', 'event: completion\ndata: {"status":"completed"\n\n', 'CODEX_GATEWAY_INVALID_RESPONSE']
  ];

  for (const [name, stream, code] of cases) {
    const { client, getCalls } = clientWithResponse(sseResponse(stream));
    await assert.rejects(() => client.run({ prompt: name }), error => error.code === code);
    assert.equal(getCalls(), 1, `${name} must not replay the POST`);
  }
});

test('Codex client rejects truncated UTF-8, invalid upstream session, and wrong SSE content type', async () => {
  const truncatedUtf8 = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0xe7]));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
  const utf8Client = clientWithResponse(truncatedUtf8).client;
  await assert.rejects(() => utf8Client.run({ prompt: 'utf8' }), error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE');

  const invalidSessionClient = clientWithResponse(sseResponse(
    'event: session\ndata: {"sessionId":"private-thread"}\n\n'
  )).client;
  await assert.rejects(() => invalidSessionClient.run({ prompt: 'session' }), error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE');

  const mismatchClient = clientWithResponse(sseResponse(
    'event: session\ndata: {"sessionId":"gs_' + '9'.repeat(64) + '"}\n\n'
  )).client;
  await assert.rejects(() => mismatchClient.run({
    prompt: 'mismatch',
    sessionId: 'gs_' + '8'.repeat(64)
  }), error => error.code === 'CODEX_SESSION_MISMATCH');

  const wrongContentTypeClient = clientWithResponse(new Response('not-sse', {
    status: 200,
    headers: { 'content-type': 'text/plain' }
  })).client;
  await assert.rejects(() => wrongContentTypeClient.run({ prompt: 'content-type' }), error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE');
});

test('Codex client bounds Gateway-sized output, message count, and cumulative SSE input', async () => {
  const sessionId = 'gs_' + '2'.repeat(64);
  const maxMessage = 'x'.repeat(MAX_CODEX_GATEWAY_OUTPUT_BYTES);
  const stream = [
    `event: session\ndata: {"sessionId":"${sessionId}"}\n\n`,
    `event: message\ndata: ${JSON.stringify({ text: maxMessage })}\n\n`,
    'event: completion\ndata: {"status":"completed"}\n\n'
  ].join('');
  const maxClient = clientWithResponse(sseResponse(stream)).client;
  const result = await maxClient.run({ prompt: 'large' });
  assert.equal(result.messages[0].length, MAX_CODEX_GATEWAY_OUTPUT_BYTES);
  assert.equal(MAX_CODEX_SSE_INPUT_BYTES > MAX_CODEX_GATEWAY_OUTPUT_BYTES, true);

  const emptyMessages = Array.from({ length: MAX_CODEX_MESSAGE_COUNT + 1 }, () => (
    'event: message\ndata: {"text":""}\n\n'
  )).join('');
  const emptyClient = clientWithResponse(sseResponse(emptyMessages)).client;
  await assert.rejects(() => emptyClient.run({ prompt: 'too-many-empty-messages' }), error => (
    error.code === 'CODEX_GATEWAY_INVALID_RESPONSE'
  ));

  const tinyMessages = Array.from({ length: MAX_CODEX_MESSAGE_COUNT }, () => (
    'event: message\ndata: {"text":"x"}\n\n'
  )).join('');
  const tinyStream = [
    `event: session\ndata: {"sessionId":"${sessionId}"}\n\n`,
    tinyMessages,
    'event: completion\ndata: {"status":"completed"}\n\n'
  ].join('');
  const tinyResult = await clientWithResponse(sseResponse(tinyStream)).client.run({ prompt: 'many-tiny-messages' });
  assert.equal(tinyResult.messages.length, MAX_CODEX_MESSAGE_COUNT);

  const heartbeat = ': ' + 'h'.repeat(1024) + '\n\n';
  const heartbeatCount = Math.ceil((MAX_CODEX_SSE_INPUT_BYTES + 1) / Buffer.byteLength(heartbeat, 'utf8'));
  const cumulativeInput = heartbeat.repeat(heartbeatCount);
  const cumulativeClient = clientWithResponse(chunkedSseResponse(cumulativeInput, 257)).client;
  await assert.rejects(() => cumulativeClient.run({ prompt: 'cumulative-input-limit' }), error => (
    error.code === 'CODEX_GATEWAY_INVALID_RESPONSE'
  ));
});

test('Codex client rejects a same-chunk completion after cumulative input limit before forwarding it', async () => {
  const message = 'x'.repeat(3 * 1024 * 1024);
  const encoder = new TextEncoder();
  const events = [];
  const { client } = clientWithResponse(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ text: message })}\n\n`));
      controller.enqueue(encoder.encode([
        `event: message\ndata: ${JSON.stringify({ text: message })}\n\n`,
        'event: completion\ndata: {"status":"completed"}\n\n'
      ].join('')));
      controller.close();
    }
  }), { headers: { 'content-type': 'text/event-stream' } }));

  await assert.rejects(() => client.run({
    prompt: 'same-chunk-limit',
    onEvent: event => events.push(event)
  }), error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE');
  assert.deepEqual(events.map(event => ({ type: event.type, textLength: event.text?.length })), [
    { type: 'message', textLength: message.length }
  ]);
  assert.equal(events.some(event => event.type === 'completion'), false);
});

test('Codex client maps controlled error events without exposing raw upstream data', async () => {
  const events = [];
  const { client, getCalls } = clientWithResponse(sseResponse(
    'event: error\ndata: {"code":"BUSY","detail":"private upstream detail"}\n\n'
  ));
  await assert.rejects(() => client.run({ prompt: 'hello', onEvent: event => events.push(event) }), error => {
    assert.equal(error.code, 'BUSY');
    assert.equal(error.status, 409);
    assert.doesNotMatch(error.message, /private upstream detail/);
    return true;
  });
  assert.equal(getCalls(), 1);
  assert.deepEqual(events, [{ type: 'error', payload: { code: 'BUSY' }, code: 'BUSY' }]);
  assert.doesNotMatch(JSON.stringify(events), /private upstream detail/);
});

test('Codex client times out while reading an already-open SSE body', async () => {
  let bodyAborted = false;
  const { client } = clientWithResponse(request => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: status\ndata: {"status":"running"}\n\n'));
        request.signal.addEventListener('abort', () => {
          bodyAborted = true;
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }, { timeoutMs: 20 });

  await assert.rejects(() => client.run({ prompt: 'body-timeout' }), error => error.code === 'CODEX_GATEWAY_TIMEOUT');
  assert.equal(bodyAborted, true);
});

test('Codex client aborts and times out without waiting forever', async () => {
  let timeoutAborted = false;
  const timed = clientWithResponse(request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      timeoutAborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  }), { timeoutMs: 20 }).client;
  await assert.rejects(() => timed.run({ prompt: 'timeout' }), error => error.code === 'CODEX_GATEWAY_TIMEOUT');
  assert.equal(timeoutAborted, true);

  const controller = new AbortController();
  let callerAborted = false;
  const aborted = clientWithResponse(request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      callerAborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  })).client;
  const pending = aborted.run({ prompt: 'cancel', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(callerAborted, true);
});

test('Codex client deletes only a valid session mapping and maps controlled delete errors', async () => {
  const sessionId = 'gs_' + 'b'.repeat(64);
  const calls = [];
  const client = createCodexGatewayClient({
    baseUrl: 'https://gateway.test',
    token: TEST_TOKEN,
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return new Response(JSON.stringify({ status: 'deleted' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await client.deleteSession(sessionId);
  assert.deepEqual(result, { deleted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://gateway.test/v1/sessions/${sessionId}`);
  assert.equal(calls[0].request.method, 'DELETE');
  assert.equal(calls[0].request.redirect, 'error');
  assert.equal(calls[0].request.headers.authorization, `Bearer ${TEST_TOKEN}`);
  await assert.rejects(() => client.deleteSession('bad-session'), error => error.code === 'CODEX_INVALID_SESSION');

  const activeClient = createCodexGatewayClient({
    baseUrl: 'https://gateway.test',
    token: TEST_TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'SESSION_ACTIVE' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(() => activeClient.deleteSession(sessionId), error => error.code === 'SESSION_ACTIVE');
  const unknownClient = createCodexGatewayClient({
    baseUrl: 'https://gateway.test',
    token: TEST_TOKEN,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'UNKNOWN_SESSION' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(() => unknownClient.deleteSession(sessionId), error => error.code === 'UNKNOWN_SESSION');
});

test('Codex client refuses non-HTTPS URLs unless loopback testing is explicitly enabled', () => {
  assert.throws(() => createCodexGatewayClient({ baseUrl: 'http://gateway.example', token: TEST_TOKEN }), error => {
    assert.equal(error.code, 'CODEX_GATEWAY_NOT_CONFIGURED');
    return true;
  });
  assert.throws(() => createCodexGatewayClient({ baseUrl: 'https://user:password@gateway.example', token: TEST_TOKEN }), error => {
    assert.equal(error.code, 'CODEX_GATEWAY_NOT_CONFIGURED');
    return true;
  });
  assert.throws(() => createCodexGatewayClient({ baseUrl: 'https://gateway.example', token: 'not-a-token' }), error => {
    assert.equal(error.code, 'CODEX_GATEWAY_NOT_CONFIGURED');
    return true;
  });
  assert.doesNotThrow(() => createCodexGatewayClient({
    baseUrl: 'http://127.0.0.1:43123',
    token: TEST_TOKEN,
    allowHttpLoopback: true,
    fetchImpl: async () => sseResponse('')
  }));
});

test('Codex client rejects redirects without contacting the target or replaying', async () => {
  let gatewayRequests = 0;
  let targetRequests = 0;
  const redirectServer = http.createServer((request, response) => {
    if (request.url === '/v1/agent/stream') gatewayRequests += 1;
    if (request.url === '/redirect-target') targetRequests += 1;
    response.writeHead(request.url === '/v1/agent/stream' ? 302 : 200, {
      location: '/redirect-target',
      'content-type': 'application/json'
    });
    response.end(JSON.stringify({ error: 'BUSY' }));
  });
  await new Promise(resolve => redirectServer.listen(0, '127.0.0.1', resolve));
  const port = redirectServer.address().port;
  const client = createCodexGatewayClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token: TEST_TOKEN,
    allowHttpLoopback: true
  });
  try {
    await assert.rejects(() => client.run({ prompt: 'redirect' }), error => error.code === 'CODEX_GATEWAY_UNAVAILABLE');
    assert.equal(gatewayRequests, 1);
    assert.equal(targetRequests, 0);
  } finally {
    await new Promise(resolve => redirectServer.close(resolve));
  }
});

test('Codex client maps only explicit HTTP error codes and consumes error bodies', async () => {
  const cases = [
    [409, { error: 'BUSY' }, 'BUSY'],
    [409, { error: 'CAPACITY_LIMIT' }, 'CODEX_GATEWAY_REJECTED'],
    [404, { error: 'UNKNOWN_SESSION' }, 'UNKNOWN_SESSION'],
    [404, { error: 'not-a-controlled-code' }, 'CODEX_GATEWAY_REJECTED'],
    [401, { error: 'anything' }, 'CODEX_GATEWAY_AUTH_FAILED']
  ];
  for (const [status, body, expectedCode] of cases) {
    const { client } = clientWithResponse(new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' }
    }));
    await assert.rejects(() => client.run({ prompt: `http-${status}` }), error => error.code === expectedCode);
  }
  const oversized = clientWithResponse(new Response(JSON.stringify({ error: 'BUSY' }) + 'x'.repeat(65536), {
    status: 500,
    headers: { 'content-type': 'application/json' }
  })).client;
  await assert.rejects(() => oversized.run({ prompt: 'oversized-error' }), error => error.code === 'CODEX_GATEWAY_UNAVAILABLE');
});

test('Codex DELETE rejects invalid success responses and requires status deleted', async () => {
  const sessionId = 'gs_' + '3'.repeat(64);
  const responses = [
    new Response('', { status: 200, headers: { 'content-type': 'text/html' } }),
    new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }),
    new Response(JSON.stringify({ status: 'other' }), { status: 200, headers: { 'content-type': 'application/json' } })
  ];
  for (const response of responses) {
    const client = createCodexGatewayClient({
      baseUrl: 'https://gateway.test',
      token: TEST_TOKEN,
      fetchImpl: async () => response
    });
    await assert.rejects(() => client.deleteSession(sessionId), error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE');
  }
});

test('Codex DELETE maps response-body timeout and caller cancellation distinctly', async () => {
  const sessionId = 'gs_' + '4'.repeat(64);
  const stalledClient = createCodexGatewayClient({
    baseUrl: 'https://gateway.test',
    token: TEST_TOKEN,
    timeoutMs: 20,
    fetchImpl: async (_url, request) => new Response(new ReadableStream({
      start(controller) {
        request.signal.addEventListener('abort', () => {
          controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  await assert.rejects(() => stalledClient.deleteSession(sessionId), error => error.code === 'CODEX_GATEWAY_TIMEOUT');

  const controller = new AbortController();
  const cancelledClient = createCodexGatewayClient({
    baseUrl: 'https://gateway.test',
    token: TEST_TOKEN,
    fetchImpl: async (_url, request) => new Response(new ReadableStream({
      start(streamController) {
        request.signal.addEventListener('abort', () => {
          streamController.error(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const pending = cancelledClient.deleteSession(sessionId, { signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, error => error.code === 'CODEX_GATEWAY_ABORTED');
});

test('Codex errors remain typed and do not include token or upstream URL', () => {
  const error = new CodexGatewayError('Codex Gateway unavailable', {
    code: 'CODEX_GATEWAY_UNAVAILABLE',
    status: 502
  });
  assert.equal(error.message, 'Codex Gateway unavailable');
  assert.doesNotMatch(JSON.stringify(error), /gateway\.test|Bearer/);
});
