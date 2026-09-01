const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.NODE_ENV = 'test';

const app = require('../server');

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function startServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

test('MCP stream returns usage for both LLM calls', async () => {
  const llmCalls = [];
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    let result = {};
    if (body.method === 'tools/list') {
      result = { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'tool result' }] };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const llm = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    llmCalls.push(body);
    const first = !!body.tools;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: first
        ? { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
        : { content: 'final answer' } }],
      usage: first
        ? { prompt_tokens: 1800, completion_tokens: 120, total_tokens: 1920 }
        : { prompt_tokens: 2400, completion_tokens: 200, total_tokens: 2600 }
    }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const body = {
      apiKey: 'fake',
      endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
      model: 'mock-model',
      projectId: 'p1',
      windowId: 'c1',
      interactionId: 'int-1',
      enabledToolIds: ['def-1'],
      enabledToolDefs: [{
        id: 'def-1',
        name: 'mock',
        url: 'http://127.0.0.1:' + mcp.address().port + '/mcp',
        auth: { type: 'none' }
      }],
      tokenContext: { actionType: 'mcp', interactionId: 'int-1' },
      messages: [{ role: 'user', content: '调用工具' }]
    };
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 2);
    const events = text.split(/\n\n/)
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice(6)))
      .filter(payload => payload.usageEvent);
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.usageEvent.stage), ['initial', 'followup']);
    assert.deepEqual(events.map(event => event.usageEvent.totalTokens), [1920, 2600]);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('regular stream sends usageEvent before the final DONE marker', async () => {
  const llm = await startServer(async (req, res) => {
    await readBody(req);
    res.setHeader('content-type', 'text/event-stream');
    res.end([
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      'data: ' + JSON.stringify({ usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } }),
      'data: [DONE]',
      ''
    ].join('\n'));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        interactionId: 'int-regular',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });
    const text = await response.text();
    const usageIndex = text.indexOf('"usageEvent"');
    const doneIndex = text.lastIndexOf('data: [DONE]');
    assert.equal(response.status, 200);
    assert.ok(usageIndex >= 0);
    assert.ok(doneIndex > usageIndex);
  } finally {
    await closeServer(api);
    await closeServer(llm);
  }
});
