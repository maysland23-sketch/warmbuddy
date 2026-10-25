const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const http = require('node:http');

const {
  createVercelRenderProxy,
  MAX_BODY_BYTES
} = require('../vercel-render-proxy');

const TEST_SECRET = 'proxy-secret-at-least-32-bytes-long';

function createSyntheticRequest({
  method = 'POST',
  emitBody = true,
  afterEnd = null
} = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = '/api/codex-stream?__warmbuddy_path=%2Fapi%2Fcodex%2Fstream';
  request.headers = { 'content-type': 'application/json' };
  request.complete = false;
  request.aborted = false;
  if (emitBody) {
    process.nextTick(() => {
      request.complete = true;
      request.emit('data', Buffer.from('{"prompt":"cancel"}'));
      request.emit('end');
      afterEnd?.(request);
    });
  }
  return request;
}

function createSyntheticResponse() {
  const response = new EventEmitter();
  response.statusCode = 200;
  response.headersSent = false;
  response.destroyed = false;
  response.writableEnded = false;
  response.writableFinished = false;
  response.setHeader = () => {};
  response.removeHeader = () => {};
  response.write = () => {
    response.headersSent = true;
    return true;
  };
  response.end = () => {
    response.headersSent = true;
    response.writableEnded = true;
    response.writableFinished = true;
  };
  response.destroyCount = 0;
  response.destroy = () => {
    response.destroyCount += 1;
    response.destroyed = true;
    response.writableEnded = true;
    response.writableFinished = true;
    response.emit('close');
  };
  return response;
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(check, 5);
    };
    check();
  });
}

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
    const response = await fetch(baseUrl + '/api/proxy?__warmbuddy_path=%2Fapi%2Fmemories%2Fp1&projectId=p1&include=latest', {
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

test('proxy aborts Render when the client closes an incomplete SSE response', async () => {
  let upstreamResponseClosed = false;
  let upstreamSocketClosed = false;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('first');
    response.once('close', () => { upstreamResponseClosed = true; });
    response.socket?.once('close', () => { upstreamSocketClosed = true; });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const handler = createVercelRenderProxy({
    renderOrigin: `http://127.0.0.1:${upstream.address().port}`,
    proxySecret: TEST_SECRET,
    logger: { info() {}, error() {} }
  });
  const proxy = http.createServer(handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const clientRequest = http.get(`http://127.0.0.1:${proxy.address().port}/api/codex/stream`);
  try {
    await new Promise((resolve, reject) => {
      clientRequest.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      clientRequest.once('response', response => {
        response.once('data', chunk => {
          assert.equal(chunk.toString(), 'first');
          clientRequest.destroy();
          resolve();
        });
      });
    });
    const started = Date.now();
    while ((!upstreamResponseClosed || !upstreamSocketClosed) && Date.now() - started < 2000) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(upstreamResponseClosed, true);
    assert.equal(upstreamSocketClosed, true);
  } finally {
    clientRequest.destroy();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
});

test('platform proxy aborts Render when a completed POST body is followed by client SSE disconnect', async () => {
  let upstreamResponseClosed = false;
  let upstreamSocketClosed = false;
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('first');
    response.once('close', () => { upstreamResponseClosed = true; });
    response.socket?.once('close', () => { upstreamSocketClosed = true; });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const handler = createVercelRenderProxy({
    renderOrigin: `http://127.0.0.1:${upstream.address().port}`,
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    logger: { info() {}, error() {} }
  });
  const proxy = http.createServer(handler);
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const clientRequest = http.request({
    hostname: '127.0.0.1',
    port: proxy.address().port,
    path: '/api/codex-stream?__warmbuddy_path=%2Fapi%2Fcodex%2Fstream',
    method: 'POST',
    headers: { 'content-type': 'application/json' }
  });
  try {
    await new Promise((resolve, reject) => {
      clientRequest.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      clientRequest.once('response', response => {
        response.once('data', chunk => {
          assert.equal(chunk.toString(), 'first');
          clientRequest.destroy();
          resolve();
        });
      });
      clientRequest.end('{"prompt":"cancel"}');
    });
    await waitFor(() => upstreamResponseClosed && upstreamSocketClosed, 2000);
  } finally {
    clientRequest.destroy();
    await new Promise(resolve => proxy.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  }
  assert.equal(upstreamResponseClosed, true);
  assert.equal(upstreamSocketClosed, true);
});

test('proxy does not abort Render after a normal SSE response completes', async () => {
  let upstreamAborted = false;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example', proxySecret: TEST_SECRET,
    fetchImpl: async (_url, init) => {
      init.signal.addEventListener('abort', () => { upstreamAborted = true; }, { once: true });
      return new Response(new TextEncoder().encode('data: [DONE]\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    },
    logger: { info() {}, error() {} }
  });

  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/api/codex/stream');
    assert.equal(await response.text(), 'data: [DONE]\n\n');
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(upstreamAborted, false);
});

test('platform fetch rejection after cancellation closes the response and cleans listeners', async () => {
  for (const event of ['aborted', 'error']) {
    const request = createSyntheticRequest();
    const response = createSyntheticResponse();
    let fetchSignal;
    let fetchRejected = false;
    let abortCount = 0;
    const handler = createVercelRenderProxy({
      renderOrigin: 'https://render.example',
      proxySecret: TEST_SECRET,
      cancellationMode: 'platform',
      fixedPathname: '/api/codex/stream',
      fetchImpl: async (_url, init) => {
        fetchSignal = init.signal;
        init.signal.addEventListener('abort', () => {
          abortCount += 1;
        }, { once: true });
        return await new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            fetchRejected = true;
            const error = new Error('synthetic abort');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      logger: { info() {}, error() {} }
    });

    const pending = handler(request, response);
    await waitFor(() => fetchSignal !== undefined);
    assert.equal(request.complete, true);
    if (event === 'error') {
      const error = new Error('aborted');
      error.code = 'ECONNRESET';
      request.emit('error', error);
      request.aborted = true;
      request.emit('aborted');
    } else {
      request.aborted = true;
      request.emit('aborted');
      const error = new Error('duplicate cancellation');
      error.code = 'ECONNRESET';
      request.emit('error', error);
    }
    await pending;
    assert.equal(fetchSignal.aborted, true);
    assert.equal(fetchRejected, true);
    assert.equal(abortCount, 1);
    assert.equal(response.destroyed, true);
    assert.equal(response.destroyCount, 1);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(request.listenerCount('close'), 0);
    assert.equal(request.listenerCount('error'), 0);
  }
});

test('platform cancellation at the body handoff does not start Render', async () => {
  let fetchCalled = false;
  const request = createSyntheticRequest({
    afterEnd(currentRequest) {
      currentRequest.aborted = true;
      currentRequest.emit('aborted');
    }
  });
  const response = createSyntheticResponse();
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    },
    logger: { info() {}, error() {} }
  });

  await handler(request, response);
  assert.equal(fetchCalled, false);
  assert.equal(response.destroyed, true);
  assert.equal(response.destroyCount, 1);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(request.listenerCount('error'), 0);
});

test('platform cancellation during body reading closes the response without fetching', async () => {
  let fetchCalled = false;
  const request = createSyntheticRequest({ emitBody: false });
  const response = createSyntheticResponse();
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    },
    logger: { info() {}, error() {} }
  });

  const pending = handler(request, response);
  await waitFor(() => request.listenerCount('data') > 0);
  request.aborted = true;
  request.emit('aborted');
  await pending;
  assert.equal(fetchCalled, false);
  assert.equal(response.destroyed, true);
  assert.equal(response.destroyCount, 1);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(request.listenerCount('error'), 0);
});

test('platform mode does not fetch after the response is already destroyed', async () => {
  let fetchCalled = false;
  const request = createSyntheticRequest({ method: 'GET', emitBody: false });
  const response = createSyntheticResponse();
  response.destroyed = true;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    },
    logger: { info() {}, error() {} }
  });

  await handler(request, response);
  assert.equal(fetchCalled, false);
  assert.equal(response.destroyCount, 0);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(request.listenerCount('error'), 0);
});

test('platform mode does not treat a normal completed request close as cancellation', async () => {
  const request = createSyntheticRequest();
  const response = createSyntheticResponse();
  let fetchSignal;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async (_url, init) => {
      fetchSignal = init.signal;
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { info() {}, error() {} }
  });

  const pending = handler(request, response);
  await waitFor(() => fetchSignal !== undefined);
  assert.equal(request.complete, true);
  request.emit('close');
  await pending;
  assert.equal(fetchSignal.aborted, false);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
  assert.equal(request.listenerCount('error'), 0);
});

test('legacy mode retains the completed-request cancellation condition', async () => {
  const request = createSyntheticRequest();
  const response = createSyntheticResponse();
  let fetchSignal;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    fetchImpl: async (_url, init) => {
      fetchSignal = init.signal;
      await new Promise(resolve => setTimeout(resolve, 25));
      return new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { info() {}, error() {} }
  });

  const pending = handler(request, response);
  await waitFor(() => fetchSignal !== undefined);
  assert.equal(request.complete, true);
  request.aborted = true;
  request.emit('aborted');
  await pending;
  assert.equal(fetchSignal.aborted, false);
  assert.equal(response.writableFinished, true);
  assert.equal(request.listenerCount('aborted'), 0);
  assert.equal(request.listenerCount('close'), 0);
});

test('platform mode aborts and cleans the upstream body when pipeline fails', async () => {
  let upstreamAborted = false;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async (_url, init) => {
      init.signal.addEventListener('abort', () => { upstreamAborted = true; }, { once: true });
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
          setTimeout(() => controller.error(new Error('synthetic pipeline failure')), 0);
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
    logger: { info() {}, error() {} }
  });

  await withProxy(handler, async baseUrl => {
    const response = await fetch(baseUrl + '/api/codex-stream?__warmbuddy_path=%2Fapi%2Fcodex%2Fstream');
    await assert.rejects(() => response.text());
    await waitFor(() => upstreamAborted, 2000);
  });
  assert.equal(upstreamAborted, true);
});

test('fixed Codex proxy rejects direct and forged non-Codex paths', async () => {
  let observedUrl;
  const handler = createVercelRenderProxy({
    renderOrigin: 'https://render.example',
    proxySecret: TEST_SECRET,
    cancellationMode: 'platform',
    fixedPathname: '/api/codex/stream',
    fetchImpl: async url => {
      observedUrl = url;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    logger: { info() {}, error() {} }
  });

  await withProxy(handler, async baseUrl => {
    const direct = await fetch(baseUrl + '/api/codex-stream');
    assert.equal(direct.status, 404);
    const forged = await fetch(baseUrl + '/api/codex-stream?__warmbuddy_path=%2Fapi%2Fchat%2Fstream');
    assert.equal(forged.status, 404);
    const exact = await fetch(baseUrl + '/api/codex-stream?__warmbuddy_path=%2Fapi%2Fcodex%2Fstream');
    assert.equal(exact.status, 200);
  });
  assert.equal(observedUrl, 'https://render.example/api/codex/stream');
});
