const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  createVercelRenderProxy,
  MAX_BODY_BYTES
} = require('../vercel-render-proxy');

const TEST_SECRET = 'proxy-secret-at-least-32-bytes-long';

async function withProxy(handler, callback) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('proxy preserves the original nested API path, query, method, body, and safe headers', async () => {
  let observed;
  const logs = [];
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-upstream-secret': 'drop-me' }
      });
    },
    logger: { info(...args) { logs.push(args); }, error(...args) { logs.push(args); } }
  });

  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/api/memories/p1?projectId=p1&include=latest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'vercel-session=private',
        authorization: 'Bearer browser-value',
        'x-warmbuddy-proxy-secret': 'spoofed'
      },
      body: '{"message":"hello"}'
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get('x-upstream-secret'), null);
  });

  assert.equal(observed.url, 'https://render.example/api/memories/p1?projectId=p1&include=latest');
  assert.equal(observed.init.method, 'POST');
  assert.equal(Buffer.from(observed.init.body).toString(), '{"message":"hello"}');
  assert.equal(observed.init.headers['content-type'], 'application/json');
  assert.equal(observed.init.headers['x-warmbuddy-proxy-secret'], TEST_SECRET);
  assert.equal(observed.init.headers.cookie, undefined);
  assert.equal(observed.init.headers.authorization, undefined);
  assert.deepEqual(logs, [
    ['[render-proxy]', {
      incomingPathname: '/api/memories/p1',
      resolvedTargetPathname: '/api/memories/p1',
      upstreamStatus: 201
    }]
  ]);
  const logText = JSON.stringify(logs);
  assert.doesNotMatch(logText, /TEST_SECRET|proxy-secret-at-least|spoofed|browser-value|hello|mode=test/);
});

test('proxy logs a missing API prefix without contacting Render', async () => {
  let called = false;
  const logs = [];
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
    logger: {
      info(...args) { logs.push(args); },
      error(...args) { logs.push(args); }
    }
  });

  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/memories/p1');
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Not found', code: 'NOT_FOUND' });
  });

  assert.equal(called, false);
  assert.deepEqual(logs, [
    ['[render-proxy]', {
      incomingPathname: '/memories/p1',
      resolvedTargetPathname: '/memories/p1',
      upstreamStatus: null
    }]
  ]);
});

test('proxy maps missing configuration, unsupported methods, and upstream failures', async () => {
  const missing = createVercelRenderProxy({ logger: { info() {}, error() {} } });
  await withProxy(missing, async baseUrl => {
    const response = await fetch(baseUrl + '/api/health');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Proxy not configured', code: 'PROXY_NOT_CONFIGURED' });
  });

  const method = createVercelRenderProxy({
    renderOrigin: 'https://render.example', proxySecret: TEST_SECRET,
    fetchImpl: async () => { throw new Error('should not fetch'); },
    logger: { info() {}, error() {} }
  });
  await withProxy(method, async baseUrl => {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(baseUrl + '/api/health', { method: 'TRACE' }, result => {
        const chunks = [];
        result.on('data', chunk => chunks.push(chunk));
        result.on('end', () => resolve({ status: result.statusCode, body: Buffer.concat(chunks).toString() }));
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response.status, 405);
    assert.deepEqual(JSON.parse(response.body), { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
  });

  const upstream = createVercelRenderProxy({
    renderOrigin: 'https://render.example', proxySecret: TEST_SECRET,
    fetchImpl: async () => { throw new Error('connection details must not be logged'); },
    logger: { info() {}, error(...args) { assert.doesNotMatch(JSON.stringify(args), /connection details/); } }
  });
  await withProxy(upstream, async baseUrl => {
    const response = await fetch(baseUrl + '/api/health');
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Upstream unavailable', code: 'UPSTREAM_UNAVAILABLE' });
  });
});

test('proxy rejects oversized request bodies before calling Render', async () => {
  let called = false;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example', proxySecret: TEST_SECRET,
    fetchImpl: async () => { called = true; return new Response('{}'); },
    logger: { info() {}, error() {} }
  });
  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 1)
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request too large', code: 'REQUEST_TOO_LARGE' });
  });
  assert.equal(called, false);
});

test('proxy streams upstream response before upstream body closes', async () => {
  let releaseSecondChunk;
  const secondChunk = new Promise(resolve => { releaseSecondChunk = resolve; });
  const upstreamBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first'));
      secondChunk.then(() => {
        controller.enqueue(new TextEncoder().encode('second'));
        controller.close();
      });
    }
  });
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example', proxySecret: TEST_SECRET,
    fetchImpl: async () => new Response(upstreamBody, {
      status: 200, headers: { 'content-type': 'text/event-stream' }
    }),
    logger: { info() {}, error() {} }
  });

  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/api/chat/stream');
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'first');
    releaseSecondChunk();
    const rest = await reader.read();
    assert.equal(new TextDecoder().decode(rest.value), 'second');
    assert.equal((await reader.read()).done, true);
  });
});
