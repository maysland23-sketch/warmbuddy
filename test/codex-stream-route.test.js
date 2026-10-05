const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.NODE_ENV = 'test';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';

const app = require('../server');
const { CodexGatewayError } = require('../codex-gateway');

const PROXY_HEADERS = {
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

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for route state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Codex route streams named events and forwards only prompt/session to the client', async () => {
  const calls = [];
  app.locals.codexGatewayClient = {
    run: async ({ prompt, sessionId, signal, onEvent }) => {
      calls.push({ prompt, sessionId, signal });
      await onEvent({ type: 'session', payload: { sessionId: 'gs_' + 'c'.repeat(64) } });
      await onEvent({ type: 'status', payload: { status: 'running' } });
      await onEvent({ type: 'message', payload: { text: '完整消息一' }, text: '完整消息一' });
      await onEvent({ type: 'message', payload: { text: '完整消息二' }, text: '完整消息二' });
      await onEvent({ type: 'completion', payload: { status: 'completed' } });
      return { completed: true, sessionId: 'gs_' + 'c'.repeat(64), messages: ['完整消息一', '完整消息二'] };
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'hello', sessionId: 'gs_' + 'd'.repeat(64) })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.match(body, /event: session\ndata: \{"sessionId":"gs_c{64}"\}/);
    assert.match(body, /event: message\ndata: \{"text":"完整消息一"\}/);
    assert.match(body, /event: message\ndata: \{"text":"完整消息二"\}/);
    assert.match(body, /event: completion\ndata: \{"status":"completed"\}/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'hello');
    assert.equal(calls[0].sessionId, 'gs_' + 'd'.repeat(64));
    assert.equal(typeof calls[0].signal, 'object');
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route aborts a bounded response backpressure wait on client disconnect', async () => {
  let gatewayAborted = false;
  app.locals.codexGatewayClient = {
    run: async ({ signal, onEvent }) => {
      signal.addEventListener('abort', () => { gatewayAborted = true; }, { once: true });
      await onEvent({ type: 'message', payload: { text: 'x'.repeat(8 * 1024 * 1024) } });
      await onEvent({ type: 'completion', payload: { status: 'completed' } });
      return { completed: true, sessionId: 'gs_' + 'a'.repeat(64), messages: [] };
    }
  };
  const api = await startApi();
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function(...args) {
    const result = originalWrite.apply(this, args);
    if (this.getHeader('content-type') === 'text/event-stream') return false;
    return result;
  };

  try {
    const responseStarted = new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
        headers: PROXY_HEADERS
      }, response => {
        response.destroy();
        resolve();
      });
      request.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      request.end(JSON.stringify({ prompt: 'backpressure' }));
    });
    await responseStarted;
    await waitFor(() => gatewayAborted);
    assert.equal(gatewayAborted, true);
  } finally {
    http.ServerResponse.prototype.write = originalWrite;
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route releases a response on bounded backpressure timeout', async () => {
  let writeErrorCode = null;
  app.locals.codexResponseWriteTimeoutMs = 20;
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      try {
        await onEvent({ type: 'message', payload: { text: 'blocked' } });
      } catch (error) {
        writeErrorCode = error.code;
        throw error;
      }
    }
  };
  const api = await startApi();
  const originalWrite = http.ServerResponse.prototype.write;
  http.ServerResponse.prototype.write = function(...args) {
    const result = originalWrite.apply(this, args);
    if (this.getHeader('content-type') === 'text/event-stream') return false;
    return result;
  };
  let request;

  try {
    const responseClosed = new Promise((resolve, reject) => {
      request = http.request(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
        method: 'POST',
        headers: PROXY_HEADERS
      }, response => {
        response.once('close', resolve);
        response.once('error', error => {
          if (error.code !== 'ECONNRESET') reject(error);
        });
        response.resume();
      });
      request.once('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      request.end(JSON.stringify({ prompt: 'backpressure-timeout' }));
    });
    const startedAt = Date.now();
    await responseClosed;
    await waitFor(() => writeErrorCode !== null);
    assert.equal(writeErrorCode, 'CODEX_RESPONSE_BACKPRESSURE_TIMEOUT');
    assert.equal(Date.now() - startedAt < 1000, true);
  } finally {
    if (request) request.destroy();
    http.ServerResponse.prototype.write = originalWrite;
    delete app.locals.codexResponseWriteTimeoutMs;
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route rejects extra browser fields and does not expose gateway configuration', async () => {
  let called = false;
  app.locals.codexGatewayClient = { run: async () => { called = true; } };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: { ...PROXY_HEADERS, authorization: 'Bearer browser-token' },
      body: JSON.stringify({ prompt: 'hello', token: 'browser-token', url: 'https://private.example', threadId: 'private-thread' })
    });
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.match(body, /CODEX_INVALID_REQUEST/);
    assert.doesNotMatch(body, /browser-token|private\.example|private-thread|Bearer/);
    assert.equal(called, false);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route emits controlled failed completion and never turns errors into success', async () => {
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      await onEvent({ type: 'message', payload: { text: 'partial' }, text: 'partial' });
      throw new CodexGatewayError('Codex Gateway is busy', { status: 409, code: 'BUSY' });
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'hello' })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: message\ndata: \{"text":"partial"\}/);
    assert.match(body, /event: error\ndata: \{"code":"BUSY"\}/);
    assert.match(body, /event: completion\ndata: \{"status":"failed"\}/);
    assert.doesNotMatch(body, /Bearer|CODEX_GATEWAY_TOKEN|private\.example|stack|stderr/);
    assert.doesNotMatch(body, /"status":"completed"/);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route reports an upstream execution timeout as an explicit failed stream', async () => {
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      await onEvent({ type: 'message', payload: { text: 'partial before timeout' } });
      throw new CodexGatewayError('Codex Gateway timed out', {
        status: 504,
        code: 'CODEX_GATEWAY_TIMEOUT'
      });
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'timeout' })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: message\ndata: \{"text":"partial before timeout"\}/);
    assert.match(body, /event: error\ndata: \{"code":"CODEX_GATEWAY_TIMEOUT"\}/);
    assert.match(body, /event: completion\ndata: \{"status":"failed"\}/);
    assert.doesNotMatch(body, /"status":"completed"/);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route never forwards completed before validating a new session', async () => {
  app.locals.codexGatewayClient = {
    run: async ({ onEvent }) => {
      await onEvent({ type: 'message', payload: { text: 'partial' } });
      await onEvent({ type: 'completion', payload: { status: 'completed' } });
      throw new CodexGatewayError('Codex did not return a session id', {
        status: 502,
        code: 'CODEX_MISSING_SESSION'
      });
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'hello' })
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: error\ndata: \{"code":"CODEX_MISSING_SESSION"\}/);
    assert.match(body, /event: completion\ndata: \{"status":"failed"\}/);
    assert.doesNotMatch(body, /"status":"completed"/);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex route keeps missing configuration isolated to the Codex path', async () => {
  delete app.locals.codexGatewayClient;
  process.env.CODEX_GATEWAY_URL = 'https://gateway.example';
  process.env.CODEX_GATEWAY_TOKEN = 'not-a-valid-gateway-token';
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'hello' })
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: 'Codex Gateway is not configured',
      code: 'CODEX_GATEWAY_NOT_CONFIGURED'
    });
    const health = await fetch(`http://127.0.0.1:${api.address().port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  } finally {
    delete process.env.CODEX_GATEWAY_URL;
    delete process.env.CODEX_GATEWAY_TOKEN;
    await stopApi(api);
  }
});

test('Codex session delete delegates mapping deletion and preserves controlled errors', async () => {
  const calls = [];
  const sessionId = 'gs_' + 'e'.repeat(64);
  app.locals.codexGatewayClient = {
    deleteSession: async id => {
      calls.push(id);
      return { deleted: true };
    }
  };
  const api = await startApi();

  try {
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true });
    assert.deepEqual(calls, [sessionId]);

    app.locals.codexGatewayClient.deleteSession = async () => {
      throw new CodexGatewayError('Session is active', { status: 409, code: 'SESSION_ACTIVE' });
    };
    const active = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(active.status, 409);
    assert.deepEqual(await active.json(), { error: 'Codex session is active', code: 'SESSION_ACTIVE' });
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});

test('Codex session delete aborts an in-flight Gateway request when the client disconnects', async () => {
  const sessionId = 'gs_' + 'f'.repeat(64);
  let gatewaySignal;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  app.locals.codexGatewayClient = {
    deleteSession: async (_id, { signal }) => {
      gatewaySignal = signal;
      startedResolve();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    }
  };
  const api = await startApi();
  const controller = new AbortController();

  try {
    const request = fetch(`http://127.0.0.1:${api.address().port}/api/codex/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET },
      signal: controller.signal
    });
    await started;
    controller.abort();
    await request.catch(() => {});
    const startedAt = Date.now();
    while (!gatewaySignal.aborted && Date.now() - startedAt < 500) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(gatewaySignal.aborted, true);
  } finally {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  }
});
