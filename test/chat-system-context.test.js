const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.RENDER = 'true';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';
process.env.APP_PUBLIC_ORIGIN = 'https://warmbuddy.vercel.app';

const app = require('../server');
const { RENDER_PROXY_HEADER } = require('../render-api-security');

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test('Anthropic requests preserve all ordered system messages and user messages', async () => {
  let upstreamBody;
  const upstream = await startServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      upstreamBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 3, output_tokens: 1 }
      }));
    });
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1/messages';
  const apiUrl = 'http://127.0.0.1:' + api.address().port + '/api/chat';

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [RENDER_PROXY_HEADER]: process.env.RENDER_PROXY_SECRET },
      body: JSON.stringify({
        apiKey: 'test-key',
        endpoint: upstreamUrl,
        model: 'claude-sonnet-4-6',
        tokenContext: { skipPersistence: true },
        messages: [
          { role: 'system', content: '静态上下文' },
          { role: 'system', content: '' },
          { role: 'system', content: '动态上下文\n第二行' },
          { role: 'user', content: '用户消息' }
        ]
      })
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamBody.system, '静态上下文\n\n动态上下文\n第二行');
    assert.deepEqual(upstreamBody.messages, [{ role: 'user', content: '用户消息' }]);
  } finally {
    await new Promise(resolve => api.close(resolve));
    await stopServer(upstream);
  }
});
