const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.VERCEL = '1';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';
process.env.CODEX_E1B_ENABLED = 'true';

const { CodexGatewayError, createCodexGatewayClient } = require('../codex-gateway');
const sharedReceiptContract = require('../public/js/codex-receipt-contract');
const app = require('../server');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'codex-gateway-error-mapping');
const TEST_TOKEN = 'a'.repeat(64);
const API_HEADERS = {
  'content-type': 'application/json',
  'x-warmbuddy-proxy-secret': process.env.RENDER_PROXY_SECRET
};

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name), 'utf8');
}

function sseResponse(text) {
  const encoded = new TextEncoder().encode(text);
  let consumed = false;
  return {
    ok: true,
    status: 200,
    headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
    body: {
      getReader() {
        return {
          async read() {
            if (consumed) return { done: true, value: undefined };
            consumed = true;
            return { done: false, value: encoded };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function responseFromChunks(chunks, headers = { 'content-type': 'text/event-stream' }) {
  const encoded = chunks.map(chunk => chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: name => headers[name.toLowerCase()] || null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= encoded.length) return { done: true, value: undefined };
            return { done: false, value: encoded[index++] };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function loadSyncForCodex(store, fetchImpl) {
  const timeSource = fs.readFileSync('public/js/chat-time.js', 'utf8');
  const source = fs.readFileSync('public/js/sync.js', 'utf8');
  let module;
  const modules = {};
  const sandbox = {
    console, Date, Promise, encodeURIComponent, URL,
    CodexReceiptContract: sharedReceiptContract,
    fetch: fetchImpl,
    renderChatMessages() {},
    toLocalDisplayTime: value => value,
    getActiveProject: () => store.projects.find(project => project.id === store.activeProject),
    getActiveChatObj: () => store.projects.flatMap(project => project.chats).find(chat => chat.id === store.activeChat),
    getActiveApiConfig: () => ({}),
    getAIName: () => '暖伴',
    getActiveChatAiSettings: () => ({}),
    MemoryModule: { getCML: () => null, getCoreOverview: () => null },
    AppCore: {
      BACKEND_URL: 'http://app.test',
      getStore: () => store,
      getActiveProject: () => store.projects.find(project => project.id === store.activeProject),
      getActiveChatObj: () => store.projects.flatMap(project => project.chats).find(chat => chat.id === store.activeChat),
      getModule: () => null,
      saveStore() {},
      register: (name, value) => { modules[name] = value; module = value; }
    }
  };
  vm.runInNewContext(timeSource, sandbox, { filename: 'public/js/chat-time.js' });
  sandbox.AppCore.getModule = name => modules[name] || null;
  vm.runInNewContext(source, sandbox, { filename: 'public/js/sync.js' });
  return module;
}

function loadCodex(options = {}) {
  const source = fs.readFileSync('public/js/codex.js', 'utf8');
  let module;
  const sandbox = {
    console, Promise, Date, URL, TextEncoder, TextDecoder, ReadableStream, AbortController,
    CodexReceiptContract: sharedReceiptContract,
    setTimeout, clearTimeout,
    fetch: options.fetchImpl,
    localforage: options.storage || {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {}
    },
    AppCore: {
      BACKEND_URL: 'http://app.test',
      register: (_name, value) => { module = value; },
      getStore: () => options.store || { projects: [] },
      getModule: options.getModule || (() => null),
      saveStore: options.saveStore || (() => {}),
      $: () => null
    },
    ChatModule: options.chatModule,
    UIModule: { toast: options.toast || (() => {}) }
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/codex.js' });
  return module;
}

function makeGatewayClient(stream) {
  return createCodexGatewayClient({
    baseUrl: 'http://127.0.0.1:43123',
    token: TEST_TOKEN,
    allowHttpLoopback: true,
    webMode: 'native',
    fetchImpl: async () => sseResponse(stream)
  });
}

async function startApi() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function stopApi(server) {
  return new Promise(resolve => server.close(resolve));
}

async function projectFixture(port, stream) {
  app.locals.codexWebMode = 'native';
  app.locals.codexGatewayClient = makeGatewayClient(stream);
  const response = await fetch(`http://127.0.0.1:${port}/api/codex/stream`, {
    method: 'POST',
    headers: API_HEADERS,
    body: JSON.stringify({ prompt: 'synthetic fixture', receiptProfile: 'github-mcp-v1' }),
    signal: AbortSignal.timeout(1500)
  });
  return { status: response.status, text: await response.text() };
}

const cases = [
  {
    file: '01-mixed_success_with_tool_failure_and_web_source_ownership.sse',
    gatewayCode: null, status: 'completed',
    toolFailed: true, sourceCount: 2
  },
  {
    file: '02-mixed_round_failure.sse',
    gatewayCode: 'CODEX_GATEWAY_TIMEOUT', status: 'unknown',
    failureReason: 'round_failed'
  },
  {
    file: '03-mixed_protocol_failure.sse',
    gatewayCode: 'CODEX_GATEWAY_INVALID_RESPONSE', status: 'failed',
    failureReason: 'round_failed'
  },
  {
    file: '04-mixed_unfinished_success.sse',
    gatewayCode: null, status: 'completed',
    failureReason: 'turn_ended'
  },
  {
    file: '05-mixed_cancelled_connected.sse',
    gatewayCode: 'CODEX_GATEWAY_ABORTED', status: 'canceled',
    failureReason: 'cancelled'
  },
  {
    file: '06-web_source_before_failed_round.sse',
    gatewayCode: 'CODEX_GATEWAY_TIMEOUT', status: 'unknown',
    failureReason: 'round_failed', sourceCount: 1
  }
];

test('Gateway maps the six reviewed synthetic streams without exposing raw runner codes', async () => {
  for (const item of cases) {
    const events = [];
    const client = makeGatewayClient(readFixture(item.file));
    if (item.gatewayCode) {
      await assert.rejects(
        () => client.run({ prompt: item.file, receiptProfile: 'github-mcp-v1', onEvent: event => events.push(event) }),
        error => error.code === item.gatewayCode,
        item.file
      );
    } else {
      const result = await client.run({ prompt: item.file, receiptProfile: 'github-mcp-v1', onEvent: event => events.push(event) });
      assert.equal(result.completed, true, item.file);
    }
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /"code":"(?:TIMEOUT|CANCELLED|INVALID_EVENT)"/, item.file);
    if (item.file.startsWith('01-')) {
      assert.ok(events.some(event => event.type === 'activity' && event.payload.outcome === 'failed'), item.file);
      assert.equal(events.filter(event => event.type === 'source').length, 2, item.file);
    }
    if (item.file.startsWith('06-')) assert.equal(events.filter(event => event.type === 'source').length, 1, item.file);
  }
});

test('Gateway preserves the two profile negotiation HTTP errors and rejects unknown codes', async () => {
  for (const item of [
    { status: 428, raw: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED' },
    { status: 400, raw: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED', code: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED' }
  ]) {
    const client = createCodexGatewayClient({
      baseUrl: 'http://127.0.0.1:43123', token: TEST_TOKEN, allowHttpLoopback: true,
      fetchImpl: async () => new Response(JSON.stringify({ error: item.raw }), {
        status: item.status, headers: { 'content-type': 'application/json' }
      })
    });
    await assert.rejects(
      () => client.run({ prompt: item.raw }),
      error => error.code === item.code && error.status === item.status
    );
  }

  const unknown = createCodexGatewayClient({
    baseUrl: 'http://127.0.0.1:43123', token: TEST_TOKEN, allowHttpLoopback: true,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'PRIVATE_DIAGNOSTIC' }), {
      status: 502, headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(() => unknown.run({ prompt: 'unknown' }), error => (
    error.code === 'CODEX_GATEWAY_UNAVAILABLE' && !String(error.message).includes('PRIVATE_DIAGNOSTIC')
  ));
});

test('WB and browser preserve controlled profile negotiation errors', async t => {
  const api = await startApi();
  t.after(async () => {
    delete app.locals.codexGatewayClient;
    await stopApi(api);
  });

  for (const item of [
    { status: 428, code: 'CODEX_RECEIPT_PROFILE_REQUIRED' },
    { status: 400, code: 'CODEX_RECEIPT_PROFILE_UNSUPPORTED' }
  ]) {
    app.locals.codexGatewayClient = {
      run: async () => {
        throw new CodexGatewayError('private upstream detail', { status: item.status, code: item.code });
      }
    };
    const response = await fetch(`http://127.0.0.1:${api.address().port}/api/codex/stream`, {
      method: 'POST', headers: API_HEADERS,
      body: JSON.stringify({ prompt: 'profile', receiptProfile: 'github-mcp-v1' })
    });
    const text = await response.text();
    assert.equal(response.status, 200, item.code);
    assert.match(text, new RegExp(`event: error\\ndata: \\{"code":"${item.code}"\\}`), item.code);
    assert.match(text, /event: completion\ndata: \{"status":"failed"\}/, item.code);
    assert.doesNotMatch(text, /private upstream detail/, item.code);
  }

  const user = { id: 'profile-http-user', role: 'user', text: 'profile error' };
  const store = {
    activeProject: 'codex-code-test', activeChat: 'profile-http-chat',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'profile-http-chat', messages: [user] }] }]
  };
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'profile error' }), commitCodexResponse: async () => {} },
    fetchImpl: async url => url.endsWith('/api/codex/config')
      ? { ok: true, json: async () => ({ webMode: 'native', receiptProfile: 'github-mcp-v1' }) }
      : {
        ok: false, status: 428,
        text: async () => JSON.stringify({ error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED' }),
        json: async () => ({ error: 'CODEX_RECEIPT_PROFILE_REQUIRED', code: 'CODEX_RECEIPT_PROFILE_REQUIRED' })
      }
  });
  await assert.rejects(
    () => codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'profile-http-chat', userMessageIds: [user.id], userText: user.text }),
    error => error.code === 'CODEX_RECEIPT_PROFILE_REQUIRED'
  );
});

test('WB projection and browser SyncModule preserve six fixture terminal outcomes and receipts', async t => {
  const api = await startApi();
  t.after(async () => {
    delete app.locals.codexGatewayClient;
    delete app.locals.codexWebMode;
    await stopApi(api);
  });

  for (const item of cases) {
    const stream = readFixture(item.file);
    const projected = await projectFixture(api.address().port, stream);
    assert.equal(projected.status, 200, item.file);
    assert.doesNotMatch(projected.text, /"code":"(?:TIMEOUT|CANCELLED|INVALID_EVENT)"/, item.file);
    if (item.gatewayCode) assert.match(projected.text, new RegExp(`"code":"${item.gatewayCode}"`), item.file);
    else assert.match(projected.text, /event: completion\ndata: \{"status":"completed"\}/, item.file);

    const chatId = 'error-map-' + item.file.slice(0, 2);
    const user = { id: 'user-' + item.file.slice(0, 2), role: 'user', text: item.file };
    const store = {
      activeProject: 'codex-code-test', activeChat: chatId,
      projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: chatId, messages: [user] }] }]
    };
    const uploadBodies = [];
    const sync = loadSyncForCodex(store, async (_url, init) => {
      uploadBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ synced: 1, syncedMessageIds: [user.id] }) };
    });
    const syncJobs = [];
    const codex = loadCodex({
      store,
      getModule: name => name === 'sync' ? {
        scheduleCodexMessageSync: (...args) => {
          const job = sync.syncCodexMessagesToBackend(...args);
          syncJobs.push(job);
          return job;
        }
      } : null,
      chatModule: {
        buildCodexPromptContext: () => ({ prompt: 'synthetic browser prompt' }),
        commitCodexResponse: async () => {}
      },
      fetchImpl: async url => url.endsWith('/api/codex/config')
        ? { ok: true, json: async () => ({ webMode: 'native', receiptProfile: 'github-mcp-v1' }) }
        : responseFromChunks([projected.text])
    });

    if (item.gatewayCode) {
      await assert.rejects(
        () => codex.sendChatTurn({ projectId: 'codex-code-test', chatId, userMessageIds: [user.id], userText: item.file }),
        error => error.code === item.gatewayCode,
        item.file
      );
    } else {
      const result = await codex.sendChatTurn({ projectId: 'codex-code-test', chatId, userMessageIds: [user.id], userText: item.file });
      assert.equal(result.completed, true, item.file);
    }
    await Promise.all(syncJobs);

    assert.equal(user._codexTurnStatus, item.status, item.file);
    assert.equal(user._codexReceiptProfile, 'github-mcp-v1', item.file);
    assert.ok(user._codexReceipts && user._codexReceipts.activities.length > 0, item.file);
    assert.ok(uploadBodies.some(body => body.receiptProfile === 'github-mcp-v1'), item.file);
    assert.equal(user._syncDirty, false, item.file);
    assert.equal(user._synced, true, item.file);
    if (item.failureReason) {
      assert.ok(user._codexReceipts.activities.some(activity => activity.reason === item.failureReason), item.file);
    }
    if (item.toolFailed) {
      assert.ok(user._codexReceipts.activities.some(activity => activity.outcome === 'failed'), item.file);
    }
    if (item.sourceCount) {
      assert.equal(user._codexReceipts.activities.reduce((total, activity) => total + activity.sourceCards.length, 0), item.sourceCount, item.file);
    }

    const uploaded = uploadBodies[uploadBodies.length - 1].messages.find(message => message.message_id === user.id);
    assert.ok(uploaded, item.file);
    const restoredStore = {
      activeProject: 'codex-code-test', activeChat: chatId,
      projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [] }]
    };
    const restoredSync = loadSyncForCodex(restoredStore, async () => ({ ok: true, json: async () => ({}) }));
    restoredSync.mergeCodexCloudMessages(restoredStore.projects[0], [{
      projectId: uploaded.project_id, windowId: uploaded.window_id, messageId: uploaded.message_id,
      role: uploaded.role, content: uploaded.content, tokenUsage: uploaded.token_usage,
      createdAt: uploaded.created_at, metadata: uploaded.metadata
    }]);
    const restored = restoredStore.projects[0].chats[0].messages.find(message => message.id === user.id);
    assert.equal(restored._codexTurnStatus, item.status, item.file);
    assert.equal(restored._codexReceiptProfile, 'github-mcp-v1', item.file);
    assert.deepEqual(
      JSON.parse(JSON.stringify(restored._codexReceipts)),
      JSON.parse(JSON.stringify(user._codexReceipts)),
      item.file
    );
  }
});
