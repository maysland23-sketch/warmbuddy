const test = require('node:test');
const assert = require('node:assert/strict');

const {
  RENDER_PROXY_HEADER,
  createRenderApiGuard,
  sanitizeProjectConfigForClient,
  sanitizeToolDefinitionForClient,
  sanitizeToolDefinitionsForClient,
  createInternalApiFetch
} = require('../render-api-security');

const TEST_SECRET = 'server-secret-at-least-32-bytes-long';

function invokeGuard(guard, supplied) {
  let nextCalled = false;
  let status;
  let body;
  const result = {
    status(code) {
      status = code;
      return this;
    },
    json(value) {
      body = value;
      return this;
    }
  };
  const request = {
    headers: supplied === undefined ? {} : { [RENDER_PROXY_HEADER]: supplied },
    get(name) {
      return this.headers[name.toLowerCase()];
    }
  };
  guard(request, result, () => { nextCalled = true; });
  return { nextCalled, status, body };
}

test('Render API guard rejects absent and wrong secrets with the same response', () => {
  const guard = createRenderApiGuard({ secret: TEST_SECRET });
  for (const supplied of [undefined, 'wrong-secret']) {
    const result = invokeGuard(guard, supplied);
    assert.equal(result.nextCalled, false);
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, {
      error: 'Unauthorized',
      code: 'RENDER_API_UNAUTHORIZED'
    });
    assert.doesNotMatch(JSON.stringify(result), /wrong-secret|server-secret/);
  }
});

test('Render API guard accepts the exact proxy secret', () => {
  const guard = createRenderApiGuard({ secret: TEST_SECRET });
  const result = invokeGuard(guard, TEST_SECRET);
  assert.equal(result.nextCalled, true);
  assert.equal(result.status, undefined);
});

test('Render API guard refuses to initialize without a server secret', () => {
  assert.throws(
    () => createRenderApiGuard({ secret: '' }),
    /RENDER_PROXY_SECRET is required/
  );
});

test('project config exposes state and hasApiKey but not the key', () => {
  const output = sanitizeProjectConfigForClient({
    enabled: true,
    apiKey: 'llm-secret',
    endpoint: 'https://llm.example',
    _desireState: { drives: { exploration: 1 } },
    _userStatus: { mood: 'ok' },
    _aiStatus: { awake: true }
  });
  assert.deepEqual(output, {
    enabled: true,
    hasApiKey: true,
    _desireState: { drives: { exploration: 1 } },
    _userStatus: { mood: 'ok' },
    _aiStatus: { awake: true }
  });
  assert.doesNotMatch(JSON.stringify(output), /llm-secret|apiKey/);
});

test('project config returns null without a config', () => {
  assert.equal(sanitizeProjectConfigForClient(null), null);
  assert.equal(sanitizeProjectConfigForClient(undefined), null);
});

test('tool definitions expose configured state and strip URL credentials', () => {
  const output = sanitizeToolDefinitionForClient({
    id: 'mcp-1',
    name: 'Reader',
    description: 'Reads books',
    transport: 'streamable-http',
    url: 'https://mcp.example/run?token=url-secret&mode=safe',
    auth: { type: 'bearer', token: 'mcp-secret' }
  });
  assert.equal(output.url, 'https://mcp.example/run?mode=safe');
  assert.deepEqual(output.auth, { type: 'bearer', configured: true });
  assert.doesNotMatch(JSON.stringify(output), /url-secret|mcp-secret/);
});

test('tool definition sanitizer does not spread unknown sensitive fields', () => {
  const output = sanitizeToolDefinitionsForClient([{
    id: 'mcp-2',
    name: 'Reader',
    url: 'not a valid URL',
    secret: 'top-level-secret',
    headers: { authorization: 'header-secret' },
    auth: { type: 'custom', access_token: 'nested-secret' }
  }]);
  assert.deepEqual(output, [{
    id: 'mcp-2',
    name: 'Reader',
    description: '',
    transport: '',
    url: '',
    auth: { type: 'custom', configured: true }
  }]);
  assert.doesNotMatch(JSON.stringify(output), /top-level-secret|header-secret|nested-secret/);
});

test('internal API fetch fixes the origin and overwrites the proxy header', async () => {
  let observed;
  const internalFetch = createInternalApiFetch({
    origin: 'http://127.0.0.1:3000',
    secret: TEST_SECRET,
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response('{}', { status: 200 });
    }
  });
  await internalFetch('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [RENDER_PROXY_HEADER]: 'attacker-value'
    },
    body: '{}'
  });
  assert.equal(observed.url, 'http://127.0.0.1:3000/api/chat');
  assert.equal(observed.init.headers[RENDER_PROXY_HEADER], TEST_SECRET);
});

test('internal API fetch rejects non-api and absolute targets', async () => {
  const internalFetch = createInternalApiFetch({
    origin: 'http://127.0.0.1:3000',
    secret: TEST_SECRET,
    fetchImpl: async () => new Response('{}')
  });
  await assert.rejects(() => internalFetch('https://evil.example/api/chat'), /relative \/api path/);
  await assert.rejects(() => internalFetch('/healthz'), /relative \/api path/);
});
