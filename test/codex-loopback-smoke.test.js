const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';

const app = require('../server');
const { createCodexGatewayClient } = require('../codex-gateway');

const PROXY_HEADERS = {
  'content-type': 'application/json',
  'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET
};
const SESSION_ID = 'gs_' + '1'.repeat(64);
const TEST_TOKEN = 'b'.repeat(64);

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  server.closeAllConnections?.();
  server.closeIdleConnections?.();
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(next => { resolve = next; });
  return { promise, resolve };
}

async function readAll(reader, decoder, initial = '') {
  let text = initial;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

async function readUntil(reader, decoder, predicate) {
  let text = '';
  while (!predicate(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error('Loopback stream ended before target event');
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for loopback cleanup');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('Codex loopback smoke covers stream, resume, delete, cancel, failure, and no replay', async () => {
  const state = {
    posts: [],
    deletes: [],
    cancelClosed: false,
    releases: [],
    readers: [],
    controllers: []
  };
  let gateway;
  let backend;
  try {
    gateway = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      state.deletes.push({ path: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'deleted' }));
    }
    if (req.method !== 'POST' || req.url !== '/v1/agent/stream') {
      res.writeHead(404);
      return res.end();
    }

    const body = JSON.parse(await readRequestBody(req));
    state.posts.push({ body, contentType: req.headers['content-type'], authorization: req.headers.authorization });
    const sessionId = body.sessionId || SESSION_ID;
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
    res.write(`event: session\ndata: {"sessionId":"${sessionId}","threadId":"private-thread"}\n\n`);
    res.write(': heartbeat\n\n');
    res.write('event: status\ndata: {"status":"running","stderr":"private-stderr"}\n\n');
    res.write(`event: message\ndata: {"text":"首条 ${body.prompt}","stderr":"private-stderr"}\n\n`);

    if (body.prompt === 'cancel') {
      res.once('close', () => { state.cancelClosed = true; });
      return;
    }
    if (body.prompt === 'fail') {
      res.write('event: error\ndata: {"code":"BUSY"}\n\n');
      return res.end();
    }

    const release = deferred();
    state.releases.push(release);
    await release.promise;
    if (res.destroyed) return;
    res.write(`event: message\ndata: {"text":"末条 ${body.prompt}","threadId":"private-thread"}\n\n`);
    res.write('event: completion\ndata: {"status":"completed","stderr":"private-stderr"}\n\n');
    res.end();
    });

    const gatewayPort = await listen(gateway);
    backend = app.listen(0, '127.0.0.1');
    await new Promise(resolve => backend.once('listening', resolve));
    app.locals.codexGatewayClient = createCodexGatewayClient({
      baseUrl: `http://127.0.0.1:${gatewayPort}`,
      token: TEST_TOKEN,
      timeoutMs: 5000,
      allowHttpLoopback: true
    });
    const backendUrl = `http://127.0.0.1:${backend.address().port}`;

    const firstResponse = await fetch(`${backendUrl}/api/codex/stream`, {
      method: 'POST', headers: PROXY_HEADERS, body: JSON.stringify({ prompt: 'hello' })
    });
    const firstReader = firstResponse.body.getReader();
    state.readers.push(firstReader);
    const firstDecoder = new TextDecoder();
    const firstChunk = await readUntil(firstReader, firstDecoder, text => /首条 hello/.test(text));
    assert.doesNotMatch(firstChunk, /completion/);
    assert.equal(state.releases.length, 1);
    state.releases.shift().resolve();
    const firstBody = await readAll(firstReader, firstDecoder, firstChunk);
    assert.match(firstBody, /首条 hello/);
    assert.match(firstBody, /末条 hello/);
    assert.match(firstBody, /event: completion\ndata: \{"status":"completed"\}/);
    assert.doesNotMatch(firstBody, /private-thread|private-stderr/);

    const resumeResponse = await fetch(`${backendUrl}/api/codex/stream`, {
      method: 'POST', headers: PROXY_HEADERS,
      body: JSON.stringify({ prompt: 'resume', sessionId: SESSION_ID })
    });
    const resumeReader = resumeResponse.body.getReader();
    state.readers.push(resumeReader);
    const resumeDecoder = new TextDecoder();
    const resumeChunk = await readUntil(resumeReader, resumeDecoder, text => /首条 resume/.test(text));
    assert.equal(state.releases.length, 1);
    state.releases.shift().resolve();
    assert.match(await readAll(resumeReader, resumeDecoder, resumeChunk), /status":"completed/);

    const failed = await fetch(`${backendUrl}/api/codex/stream`, {
      method: 'POST', headers: PROXY_HEADERS, body: JSON.stringify({ prompt: 'fail' })
    });
    const failedBody = await failed.text();
    assert.equal(failed.status, 200);
    assert.match(failedBody, /event: error\ndata: \{"code":"BUSY"\}/);
    assert.match(failedBody, /event: completion\ndata: \{"status":"failed"\}/);
    assert.doesNotMatch(failedBody, /"status":"completed"/);

    const cancelController = new AbortController();
    state.controllers.push(cancelController);
    const cancelRequest = fetch(`${backendUrl}/api/codex/stream`, {
      method: 'POST', headers: PROXY_HEADERS, body: JSON.stringify({ prompt: 'cancel' }), signal: cancelController.signal
    });
    const cancelResponse = await cancelRequest;
    const cancelReader = cancelResponse.body.getReader();
    state.readers.push(cancelReader);
    await readUntil(cancelReader, new TextDecoder(), text => /首条 cancel/.test(text));
    cancelController.abort();
    await assert.rejects(() => cancelReader.read());
    await waitFor(() => state.cancelClosed);

    const deleted = await fetch(`${backendUrl}/api/codex/sessions/${SESSION_ID}`, {
      method: 'DELETE', headers: { 'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET }
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.deepEqual(state.deletes, [{
      path: `/v1/sessions/${SESSION_ID}`,
      authorization: `Bearer ${TEST_TOKEN}`
    }]);
    assert.equal(state.posts.length, 4);
    assert.ok(state.posts.every(entry => entry.contentType === 'application/json'));
    assert.ok(state.posts.every(entry => entry.authorization === `Bearer ${TEST_TOKEN}`));
    assert.deepEqual(Object.keys(state.posts[0].body), ['prompt']);
    assert.deepEqual(Object.keys(state.posts[1].body).sort(), ['prompt', 'sessionId']);
  } finally {
    for (const release of state.releases) release.resolve();
    for (const controller of state.controllers) controller.abort();
    for (const reader of state.readers) {
      try { await reader.cancel(); } catch {}
      try { reader.releaseLock(); } catch {}
    }
    delete app.locals.codexGatewayClient;
    if (backend) await close(backend);
    if (gateway) await close(gateway);
  }
});
