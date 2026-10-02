const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.NODE_ENV = 'test';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';

const app = require('../server');

const PROXY_HEADERS = {
  'content-type': 'application/json',
  'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET
};

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

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseSsePayloads(text) {
  return text.split(/\n\n/)
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6))
    .filter(data => data !== '[DONE]')
    .map(data => JSON.parse(data));
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
    const first = llmCalls.length === 1;
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
      headers: PROXY_HEADERS,
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
      headers: PROXY_HEADERS,
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

test('MCP stream performs multiple tool rounds and emits only assistant text', async () => {
  const mcpMethods = [];
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    mcpMethods.push(body.method);
    let result = {};
    if (body.method === 'tools/list') {
      result = { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'result-' + mcpMethods.filter(method => method === 'tools/call').length }] };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const llmCalls = [];
  const llm = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    llmCalls.push(body);
    const responses = [
      {
        content: '第一段',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
      },
      {
        content: '第二段',
        tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'lookup', arguments: '{}' } }]
      },
      { content: '最终段' }
    ];
    const message = responses[llmCalls.length - 1];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message }],
      usage: {
        prompt_tokens: 100 + llmCalls.length,
        completion_tokens: 10 + llmCalls.length,
        total_tokens: 110 + llmCalls.length * 2
      }
    }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        interactionId: 'multi-round',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{
          id: 'def-1',
          name: 'mock',
          url: 'http://127.0.0.1:' + mcp.address().port + '/mcp',
          auth: { type: 'none' }
        }],
        messages: [{ role: 'user', content: '请分两轮调用工具' }]
      })
    });
    const text = await response.text();
    const payloads = parseSsePayloads(text);
    const textPayloads = payloads.filter(payload => typeof payload.text === 'string');
    const usagePayloads = payloads.filter(payload => payload.usageEvent);

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 3);
    assert.deepEqual(llmCalls.map(body => body.tools?.length || 0), [1, 1, 1]);
    assert.deepEqual(mcpMethods.filter(method => method === 'tools/call'), ['tools/call', 'tools/call']);
    assert.deepEqual(textPayloads.map(payload => payload.text), ['第一段', '第二段', '最终段']);
    assert.ok(textPayloads.every(payload => !/tool_calls|lookup|call-[12]/.test(payload.text)));
    assert.deepEqual(usagePayloads.map(payload => payload.usageEvent.stage), ['initial', 'followup', 'followup_2']);
    assert.deepEqual(usagePayloads.map(payload => payload.usageEvent.totalTokens), [112, 114, 116]);
    assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('Anthropic MCP rounds preserve content blocks and matching tool results', async () => {
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    let result = {};
    if (body.method === 'tools/list') {
      result = { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'anthropic-result' }] };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const llmCalls = [];
  const assistantContents = [
    [
      { type: 'text', text: '甲' },
      { type: 'tool_use', id: 'anthropic-call-1', name: 'lookup', input: { q: 'one' } }
    ],
    [
      { type: 'text', text: '乙' },
      { type: 'tool_use', id: 'anthropic-call-2', name: 'lookup', input: { q: 'two' } }
    ],
    [{ type: 'text', text: '完成' }]
  ];
  const llm = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    llmCalls.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      content: assistantContents[llmCalls.length - 1],
      usage: { input_tokens: 20 + llmCalls.length, output_tokens: 5, total_tokens: 25 + llmCalls.length }
    }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/messages',
        model: 'mock-anthropic',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{
          id: 'def-1',
          name: 'mock',
          url: 'http://127.0.0.1:' + mcp.address().port + '/mcp',
          auth: { type: 'none' }
        }],
        messages: [{ role: 'user', content: '请分两轮调用工具' }]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 3);
    assert.deepEqual(llmCalls.map(request => request.tools?.length || 0), [1, 1, 1]);
    assert.deepEqual(llmCalls[1].messages.slice(-2), [
      { role: 'assistant', content: assistantContents[0] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anthropic-call-1', content: 'anthropic-result' }] }
    ]);
    assert.deepEqual(llmCalls[2].messages.slice(-2), [
      { role: 'assistant', content: assistantContents[1] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anthropic-call-2', content: 'anthropic-result' }] }
    ]);
    assert.equal(body.reply.content, '甲乙完成');
    assert.deepEqual(body.usageEvents.map(event => event.stage), ['initial', 'followup', 'followup_2']);
    assert.deepEqual(body.usageEvents.map(event => event.totalTokens), [26, 27, 28]);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('same-round multiple tool calls preserve each OpenAI tool_call_id and keep pure tool responses out of text', async () => {
  const mcpCalls = [];
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.method === 'tools/call') mcpCalls.push(body.params);
    const result = body.method === 'tools/list'
      ? { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: body.params.name + '-result-' + mcpCalls.length }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const llmCalls = [];
  const llm = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    llmCalls.push(body);
    const message = llmCalls.length === 1
      ? {
        content: null,
        tool_calls: [
          { id: 'same-round-a', type: 'function', function: { name: 'lookup', arguments: '{"slot":"a"}' } },
          { id: 'same-round-b', type: 'function', function: { name: 'lookup', arguments: '{"slot":"b"}' } }
        ]
      }
      : { content: '只发送最终文本' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{ id: 'def-1', name: 'mock', url: 'http://127.0.0.1:' + mcp.address().port + '/mcp', auth: { type: 'none' } }],
        messages: [{ role: 'user', content: '同轮两个工具' }]
      })
    });
    const text = await response.text();
    const payloads = parseSsePayloads(text);
    const textPayloads = payloads.filter(payload => typeof payload.text === 'string');
    const toolPayload = payloads.find(payload => payload._toolCalls);
    const secondRequestTools = llmCalls[1].messages.filter(message => message.role === 'tool');

    assert.equal(response.status, 200);
    assert.deepEqual(llmCalls.map(body => body.tools?.length || 0), [1, 1]);
    assert.deepEqual(mcpCalls.map(call => call.arguments), [{ slot: 'a' }, { slot: 'b' }]);
    assert.deepEqual(secondRequestTools.map(message => message.tool_call_id), ['same-round-a', 'same-round-b']);
    assert.deepEqual(textPayloads.map(payload => payload.text), ['只发送最终文本']);
    assert.deepEqual(toolPayload._toolCalls.map(call => call.name), ['lookup', 'lookup']);
    assert.doesNotMatch(text, /same-round-[ab]|"arguments"/);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('MCP tool execution failures become matched tool results and do not leak into bubble text', async () => {
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    if (body.method === 'tools/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] } }));
      return;
    }
    res.statusCode = 500;
    res.end('tool unavailable');
  });
  const llmCalls = [];
  const llm = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    llmCalls.push(body);
    const message = llmCalls.length === 1
      ? { content: null, tool_calls: [{ id: 'failed-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }
      : { content: '工具失败后仍然返回文本' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{ id: 'def-1', name: 'mock', url: 'http://127.0.0.1:' + mcp.address().port + '/mcp', auth: { type: 'none' } }],
        messages: [{ role: 'user', content: '工具失败' }]
      })
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(llmCalls.length, 2);
    assert.equal(body.reply.content, '工具失败后仍然返回文本');
    assert.match(llmCalls[1].messages.at(-1).content, /MCP upstream request failed/);
    assert.doesNotMatch(body.reply.content, /MCP upstream|failed-call|tool_calls/);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('MCP tool-round limit returns an incomplete error instead of treating a tool request as final text', async () => {
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const result = body.method === 'tools/list'
      ? { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'result' }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  let llmCalls = 0;
  const llm = await startServer(async (req, res) => {
    await readBody(req);
    llmCalls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { content: 'not-final', tool_calls: [{ id: 'loop-' + llmCalls, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }]
    }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{ id: 'def-1', name: 'mock', url: 'http://127.0.0.1:' + mcp.address().port + '/mcp', auth: { type: 'none' } }],
        messages: [{ role: 'user', content: '循环调用' }]
      })
    });
    const text = await response.text();
    const payloads = parseSsePayloads(text);
    const errorPayload = payloads.find(payload => payload.code === 'MCP_TOOL_CALL_LIMIT');

    assert.equal(response.status, 200);
    assert.ok(llmCalls >= 8);
    assert.equal(errorPayload.incomplete, true);
    assert.equal(payloads.filter(payload => payload.text === 'not-final').length, 8);
    assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1);
  } finally {
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('MCP total timeout aborts an in-flight LLM request', async () => {
  const previousTimeout = process.env.MCP_TOTAL_TIMEOUT_MS;
  process.env.MCP_TOTAL_TIMEOUT_MS = '40';
  let upstreamAborted = false;
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const result = body.method === 'tools/list'
      ? { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'result' }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const llm = await startServer(async (req, res) => {
    req.on('aborted', () => { upstreamAborted = true; });
    res.on('close', () => { if (!res.writableFinished) upstreamAborted = true; });
    await wait(150);
    if (!res.destroyed) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
    }
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: PROXY_HEADERS,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{ id: 'def-1', name: 'mock', url: 'http://127.0.0.1:' + mcp.address().port + '/mcp', auth: { type: 'none' } }],
        messages: [{ role: 'user', content: '超时' }]
      })
    });
    const text = await response.text();
    await wait(20);

    assert.equal(response.status, 200);
    assert.match(text, /MCP_CONVERSATION_TIMEOUT/);
    assert.equal(upstreamAborted, true);
  } finally {
    if (previousTimeout === undefined) delete process.env.MCP_TOTAL_TIMEOUT_MS;
    else process.env.MCP_TOTAL_TIMEOUT_MS = previousTimeout;
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});

test('MCP client disconnect aborts the in-flight LLM request', async () => {
  let upstreamAborted = false;
  const llm = await startServer(async (req, res) => {
    req.on('aborted', () => { upstreamAborted = true; });
    res.on('close', () => { if (!res.writableFinished) upstreamAborted = true; });
    await wait(200);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] }));
  });
  const mcp = await startServer(async (req, res) => {
    const body = JSON.parse(await readBody(req));
    const result = body.method === 'tools/list'
      ? { tools: [{ name: 'lookup', description: 'mock', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: 'result' }] };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const clientController = new AbortController();

  try {
    const request = fetch('http://127.0.0.1:' + api.address().port + '/api/chat/stream', {
      method: 'POST',
      headers: PROXY_HEADERS,
      signal: clientController.signal,
      body: JSON.stringify({
        apiKey: 'fake',
        endpoint: 'http://127.0.0.1:' + llm.address().port + '/v1/chat/completions',
        model: 'mock-model',
        projectId: 'p1',
        windowId: 'c1',
        enabledToolIds: ['def-1'],
        enabledToolDefs: [{ id: 'def-1', name: 'mock', url: 'http://127.0.0.1:' + mcp.address().port + '/mcp', auth: { type: 'none' } }],
        messages: [{ role: 'user', content: '断开' }]
      })
    });
    const response = await request;
    await wait(50);
    clientController.abort();
    await assert.rejects(response.text());
    await wait(100);
    assert.equal(upstreamAborted, true);
  } finally {
    clientController.abort();
    await closeServer(api);
    await closeServer(mcp);
    await closeServer(llm);
  }
});
