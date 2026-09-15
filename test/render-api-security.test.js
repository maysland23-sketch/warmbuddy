const test = require('node:test');
const assert = require('node:assert/strict');
process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.RENDER = 'true';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';
process.env.APP_PUBLIC_ORIGIN = 'https://warmbuddy.vercel.app';

const {
  RENDER_PROXY_HEADER,
  createRenderApiGuard,
  sanitizeProjectConfigForClient,
  sanitizeToolDefinitionForClient,
  sanitizeToolDefinitionsForClient,
  createInternalApiFetch
} = require('../render-api-security');

const TEST_SECRET = 'server-secret-at-least-32-bytes-long';

const app = require('../server');

function startApi() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopApi(server) {
  return new Promise(resolve => server.close(resolve));
}

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

test('healthz is public while every api route requires the proxy secret', async () => {
  const api = await startApi();
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    const health = await fetch(origin + '/healthz');
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const anonymous = await fetch(origin + '/api/health');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), {
      error: 'Unauthorized',
      code: 'RENDER_API_UNAUTHORIZED'
    });

    const authenticated = await fetch(origin + '/api/health', {
      headers: { [RENDER_PROXY_HEADER]: TEST_SECRET }
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await stopApi(api);
  }
});

test('Render root redirects to the Vercel app without copying the password query', async () => {
  const api = await startApi();
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    const response = await fetch(origin + '/?project=p1&chat=c1&pwd=legacy', { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://warmbuddy.vercel.app/?project=p1&chat=c1');
  } finally {
    await stopApi(api);
  }
});

test('Render API guard runs before the JSON body parser', async () => {
  const api = await startApi();
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    const response = await fetch(origin + '/api/health', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(5 * 1024 * 1024 + 1)
    });
    assert.equal(response.status, 401);
  } finally {
    await stopApi(api);
  }
});
