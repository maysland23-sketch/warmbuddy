const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadCodex(options = {}) {
  const source = fs.readFileSync('public/js/codex.js', 'utf8');
  let module;
  const dom = options.dom || {};
  const sandbox = {
    console,
    Promise,
    Date,
    URL,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    setTimeout,
    clearTimeout,
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
      saveStore: options.saveStore || (() => {}),
    getModule: options.getModule || (() => null),
    $: id => dom[id] || null
    },
    ChatModule: options.chatModule,
    handleEmailSend: options.handleEmailSend,
    UIModule: { toast: options.toast || (() => {}) }
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/codex.js' });
  return module;
}

test('reload marks only this device running Codex turns unknown and preserves terminal state', () => {
  const localRunning = {
    id: 'local-running', _codexRuntime: 'codex-gateway', _codexLocalDevice: true,
    _codexTurnStatus: 'running', _codexVersion: 4, content: 'partial reply'
  };
  const completed = {
    id: 'completed', _codexRuntime: 'codex-gateway', _codexLocalDevice: true,
    _codexTurnStatus: 'completed', _codexVersion: 7
  };
  const failed = {
    id: 'failed', _codexRuntime: 'codex-gateway', _codexLocalDevice: true,
    _codexTurnStatus: 'failed', _codexVersion: 8
  };
  const canceled = {
    id: 'canceled', _codexRuntime: 'codex-gateway', _codexLocalDevice: true,
    _codexTurnStatus: 'canceled', _codexVersion: 9
  };
  const otherDeviceRunning = {
    id: 'other-device', _codexRuntime: 'codex-gateway', _codexLocalDevice: false,
    _codexTurnStatus: 'running', _codexVersion: 3
  };
  const store = {
    projects: [{
      id: 'codex-code-test',
      chats: [{ id: 'chat-reload', messages: [localRunning, completed, failed, canceled, otherDeviceRunning] }]
    }]
  };
  let saves = 0;
  const codex = loadCodex({ store, saveStore: () => { saves += 1; } });

  codex.markReloadedTurnsUnknown();

  assert.equal(localRunning._codexTurnStatus, 'unknown');
  assert.equal(localRunning._codexVersion, 5);
  assert.equal(localRunning._syncDirty, true);
  assert.match(localRunning._codexUpdatedAt, /^20\d\d-/);
  assert.equal(completed._codexTurnStatus, 'completed');
  assert.equal(failed._codexTurnStatus, 'failed');
  assert.equal(canceled._codexTurnStatus, 'canceled');
  assert.equal(otherDeviceRunning._codexTurnStatus, 'running');
  assert.equal(saves, 1);
});

test('reload interrupts persisted running receipts and schedules their unknown terminal state', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const running = {
    id: 'reload-receipt', role: 'user', _codexRuntime: 'codex-gateway', _codexLocalDevice: true,
    _codexTurnStatus: 'running', _codexVersion: 4, _codexReceipts: { activities: [{
      requestId, activityId: 'wa_1', tool: 'web_search', phase: 'started', action: 'unknown', outcome: 'unknown', sourceCards: []
    }] }
  };
  const store = { projects: [{ id: 'codex-code-test', chats: [{ id: 'reload-chat', messages: [running] }] }] };
  const syncCalls = [];
  const codex = loadCodex({ store, getModule: name => name === 'sync' ? { scheduleCodexMessageSync: (...args) => syncCalls.push(args) } : null });
  codex.markReloadedTurnsUnknown();
  assert.equal(running._codexTurnStatus, 'unknown');
  assert.equal(running._codexReceipts.activities[0].phase, 'interrupted');
  assert.equal(running._codexReceipts.activities[0].reason, 'turn_ended');
  assert.deepEqual(syncCalls, [['codex-code-test', 'reload-chat']]);
});

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

function splitIntoChunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

test('Codex frontend builds the exact bounded request body and rejects extra fields', () => {
  const codex = loadCodex();
  const sessionId = 'gs_' + 'a'.repeat(64);
  assert.deepEqual(JSON.parse(codex.createRequestBody('你好', sessionId)), {
    prompt: '你好', sessionId
  });
  assert.throws(() => codex.createRequestBody('  '), /CODEX_INVALID_PROMPT/);
  assert.throws(() => codex.createRequestBody('x\0y'), /CODEX_INVALID_PROMPT/);
  assert.throws(() => codex.createRequestBody('x', 'private-thread'), /CODEX_INVALID_SESSION/);
  assert.throws(() => codex.createRequestBody('x', sessionId, { token: 'secret' }), /CODEX_INVALID_REQUEST/);
});

test('Codex frontend parses fragmented named SSE, heartbeats, Unicode, and redacts payload fields', async () => {
  const codex = loadCodex();
  const sid = 'gs_' + 'b'.repeat(64);
  const stream = [
    ': heartbeat\n\n',
    'event: session\ndata: {"sessionId":"' + sid + '","threadId":"private"}\n\n',
    'event: status\ndata: {"status":"running","stderr":"hidden"}\n\n',
    'event: message\ndata: {"text":"完整的😀消息","stderr":"hidden"}\n\n',
    'event: error\ndata: {"code":"BUSY","stderr":"hidden"}\n\n',
    'event: completion\ndata: {"status":"failed","threadId":"private"}\n\n'
  ];
  const events = [];
  await assert.rejects(
    () => codex.consumeSse(responseFromChunks(splitIntoChunks(stream.join(''), 3)), {
      onEvent: event => events.push(event)
    }),
    error => error.code === 'BUSY'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { type: 'session', payload: { sessionId: sid } },
    { type: 'status', payload: { status: 'running' } },
    { type: 'message', payload: { text: '完整的😀消息' } },
    { type: 'error', payload: { code: 'BUSY' } }
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|hidden/);
});

test('Codex frontend decodes bounded native activity/source receipts and keeps display-only URLs unclickable', async () => {
  const codex = loadCodex();
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'a'.repeat(64);
  const events = [];
  const stream = [
    `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'unknown', outcome: 'unknown', threadId: 'private' })}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'none' })}\n\n`,
    `event: source\ndata: ${JSON.stringify({ requestId, activityId, sourceId, displayUrl: 'https://example.org/article', redacted: true, title: '<img>', refId: 'ref_1', url: 'https://example.org/article?secret=1' })}\n\n`,
    'event: completion\ndata: {"status":"completed"}\n\n'
  ].join('');
  await assert.rejects(
    () => codex.consumeSse(responseFromChunks([stream]), { webMode: 'native', onEvent: event => events.push(event) }),
    error => error.code === 'CODEX_GATEWAY_INVALID_RESPONSE'
  );

  const validStream = stream.replace(',"url":"https://example.org/article?secret=1"', '');
  const validEvents = [];
  const result = await codex.consumeSse(responseFromChunks([validStream]), {
    webMode: 'native', onEvent: event => validEvents.push(event)
  });
  assert.equal(result.completed, true);
  assert.deepEqual(validEvents.map(event => event.type), ['activity', 'activity', 'source', 'completion']);
  assert.equal(JSON.stringify(validEvents[2].payload), JSON.stringify({
    requestId, activityId, sourceId, displayUrl: 'https://example.org/article', redacted: true, title: '<img>', refId: 'ref_1'
  }));
});

test('Codex frontend native mode never falls back to legacy search integration', async () => {
  const sid = 'gs_' + '1'.repeat(64);
  const store = {
    activeProject: 'codex-code-test', activeChat: 'native-search',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [
      { id: 'native-search', aiSettings: { webSearch: true }, messages: [{ id: 'native-user', role: 'user', text: '查资料' }] }
    ] }]
  };
  const calls = [];
  const configCalls = [];
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: options => { calls.push(options); return { prompt: 'native prompt' }; }, commitCodexResponse: async () => {} },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/codex/config')) {
        configCalls.push(init);
        return { ok: true, json: async () => ({ webMode: 'native' }) };
      }
      if (url.endsWith('/api/search')) throw new Error('legacy search must not run');
      return responseFromChunks([
        `event: session\ndata: {"sessionId":"${sid}"}\n\n`,
        'event: message\ndata: {"text":"回答 [[SEARCH:不应调用旧搜索]]"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });
  const result = await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'native-search', userMessageIds: ['native-user'], userText: '查资料'
  });
  assert.equal(result.completed, true);
  assert.equal(configCalls.length, 1);
  assert.equal(calls[0].codexWebMode, 'native');
});

test('Codex frontend rereads no-store web config for every turn and fixes each turn mode', async () => {
  const sid = 'gs_' + '4'.repeat(64);
  const configModes = ['legacy', 'native', 'legacy'];
  const configRequests = [];
  const gatewayRequests = [];
  const contextModes = [];
  const store = {
    activeProject: 'codex-code-test', activeChat: 'mode-switch',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{
      id: 'mode-switch', aiSettings: { webSearch: true }, messages: [
        { id: 'legacy-user', role: 'user', text: 'legacy' },
        { id: 'native-user', role: 'user', text: 'native' },
        { id: 'legacy-user-again', role: 'user', text: 'legacy again' }
      ]
    }] }]
  };
  const codex = loadCodex({
    store,
    chatModule: {
      buildCodexPromptContext: options => {
        contextModes.push(options.codexWebMode);
        return { prompt: options.codexWebMode + ' prompt' };
      },
      commitCodexResponse: async () => {}
    },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/codex/config')) {
        configRequests.push(init);
        return { ok: true, json: async () => ({ webMode: configModes.shift() }) };
      }
      gatewayRequests.push(JSON.parse(init.body));
      return responseFromChunks([
        'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
        'event: message\ndata: {"text":"回答"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });

  await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'mode-switch',
    userMessageIds: ['legacy-user'], userText: 'legacy'
  });
  await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'mode-switch',
    userMessageIds: ['native-user'], userText: 'native'
  });
  await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'mode-switch',
    userMessageIds: ['legacy-user-again'], userText: 'legacy again'
  });

  assert.equal(configRequests.length, 3);
  for (const request of configRequests) {
    assert.equal(request.cache, 'no-store');
    assert.equal(request.headers['Cache-Control'], 'no-store');
  }
  assert.deepEqual(contextModes, ['legacy', 'native', 'legacy']);
  assert.equal(gatewayRequests.length, 3);
});

test('Codex frontend stops before Gateway when web config is missing, invalid, malformed, unavailable, or non-success', async () => {
  const cases = [
    { name: 'missing', response: { ok: true, json: async () => ({}) }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'invalid', response: { ok: true, json: async () => ({ webMode: 'bogus' }) }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'toString', response: { ok: true, json: async () => ({ webMode: 'toString' }) }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'constructor', response: { ok: true, json: async () => ({ webMode: 'constructor' }) }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'proto', response: { ok: true, json: async () => ({ webMode: '__proto__' }) }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'malformed', response: { ok: true, json: async () => { throw new Error('bad json'); } }, code: 'CODEX_GATEWAY_INVALID_RESPONSE' },
    { name: 'unavailable', response: { ok: false, status: 503, json: async () => ({}) }, code: 'CODEX_GATEWAY_UNAVAILABLE' },
    { name: 'network', error: new Error('offline'), code: 'CODEX_GATEWAY_UNAVAILABLE' }
  ];
  for (const item of cases) {
    const user = { id: 'config-' + item.name, role: 'user', text: '配置检查' };
    const store = {
      activeProject: 'codex-code-test', activeChat: 'config-' + item.name,
      projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{
        id: 'config-' + item.name, messages: [user]
      }] }]
    };
    let gatewayCalls = 0;
    const toasts = [];
    const codex = loadCodex({
      store,
      toast: message => toasts.push(message),
      chatModule: { buildCodexPromptContext: () => ({ prompt: 'must not build' }), commitCodexResponse: async () => {} },
      fetchImpl: async url => {
        if (url.endsWith('/api/codex/config')) {
          if (item.error) throw item.error;
          return item.response;
        }
        gatewayCalls++;
        return responseFromChunks([]);
      }
    });
    await assert.rejects(
      () => codex.sendChatTurn({
        projectId: 'codex-code-test', chatId: 'config-' + item.name,
        userMessageIds: [user.id], userText: '配置检查'
      }),
      error => error.code === item.code
    );
    assert.equal(gatewayCalls, 0, item.name);
    assert.equal(user._codexTurnStatus, 'failed', item.name);
    assert.equal(toasts.length, 1, item.name);
  }
});

test('Codex sendChatTurn preserves a small open_page target without a synthetic omission', async () => {
  const sid = 'gs_' + 'a'.repeat(64);
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const targetUrl = 'https://example.org/guide';
  const user = { id: 'open-page-user', role: 'user', text: '打开资料' };
  const store = { activeProject: 'codex-code-test', activeChat: 'open-page-chat', projects: [{
    id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'open-page-chat', aiSettings: { webSearch: true }, messages: [user] }]
  }] };
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'native prompt' }), commitCodexResponse: async () => {} },
    fetchImpl: async url => url.endsWith('/api/codex/config')
      ? { ok: true, json: async () => ({ webMode: 'native' }) }
      : responseFromChunks([
        `event: session\ndata: {"sessionId":"${sid}"}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'open_page', outcome: 'unknown', targetSourceId: 'ws_' + 'b'.repeat(64), targetDisplayUrl: targetUrl, targetRedacted: false, targetUrl })}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'completed', action: 'open_page', outcome: 'unknown', targetSourceId: 'ws_' + 'b'.repeat(64), targetDisplayUrl: targetUrl, targetRedacted: false, targetUrl, sources: 'available' })}\n\n`,
        'event: completion\ndata: {"status":"completed"}\n\n'
      ])
  });

  const result = await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'open-page-chat', userMessageIds: [user.id], userText: user.text
  });

  assert.equal(result.completed, true);
  const receipts = user._codexReceipts;
  assert.equal(receipts.omitted, undefined);
  assert.equal(receipts.omittedSources, undefined);
  assert.equal(receipts.activities[0].targetUrl, targetUrl);
  assert.equal(receipts.activities[0].targetDisplayUrl, targetUrl);
});

test('Codex sendChatTurn preserves existing omission metadata when a later receipt remains under budget', async () => {
  const sid = 'gs_' + 'd'.repeat(64);
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const user = {
    id: 'existing-omission-user', role: 'user', text: '继续查阅',
    _codexReceipts: { activities: [], omitted: true, omittedSources: 5 }
  };
  const store = { activeProject: 'codex-code-test', activeChat: 'existing-omission-chat', projects: [{
    id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'existing-omission-chat', aiSettings: { webSearch: true }, messages: [user] }]
  }] };
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'native prompt' }), commitCodexResponse: async () => {} },
    fetchImpl: async url => url.endsWith('/api/codex/config')
      ? { ok: true, json: async () => ({ webMode: 'native' }) }
      : responseFromChunks([
        `event: session\ndata: {"sessionId":"${sid}"}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId: 'wa_1', tool: 'web_search', phase: 'started', action: 'search', outcome: 'unknown' })}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId: 'wa_1', tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'none' })}\n\n`,
        'event: completion\ndata: {"status":"completed"}\n\n'
      ])
  });

  await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'existing-omission-chat', userMessageIds: [user.id], userText: user.text
  });

  assert.equal(user._codexReceipts.omitted, true);
  assert.equal(user._codexReceipts.omittedSources, 5);
});

test('Codex sendChatTurn compacts oversized real-shaped receipts while retaining all terminal activities', async () => {
  const sid = 'gs_' + 'c'.repeat(64);
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const user = { id: 'oversized-user', role: 'user', text: '查阅大量资料' };
  const store = { activeProject: 'codex-code-test', activeChat: 'oversized-chat', projects: [{
    id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'oversized-chat', aiSettings: { webSearch: true }, messages: [user] }]
  }] };
  const events = [`event: session\ndata: {"sessionId":"${sid}"}\n\n`];
  for (let activityIndex = 1; activityIndex <= 64; activityIndex += 1) {
    const activityId = `wa_${activityIndex}`;
    events.push(`event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'search', outcome: 'unknown' })}\n\n`);
    events.push(`event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'available' })}\n\n`);
    for (let sourceIndex = 0; sourceIndex < 8; sourceIndex += 1) {
      const sourceId = 'ws_' + (activityIndex * 8 + sourceIndex).toString(16).padStart(64, '0');
      const url = `https://example.org/article-${activityIndex}-${sourceIndex}`;
      events.push(`event: source\ndata: ${JSON.stringify({ requestId, activityId, sourceId, displayUrl: url, url, redacted: false, title: 'T'.repeat(256), refId: `ref_${activityIndex}_${sourceIndex}` })}\n\n`);
    }
  }
  events.push('event: completion\ndata: {"status":"completed"}\n\n');
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'native prompt' }), commitCodexResponse: async () => {} },
    fetchImpl: async url => url.endsWith('/api/codex/config')
      ? { ok: true, json: async () => ({ webMode: 'native' }) }
      : responseFromChunks([events.join('')])
  });

  const result = await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'oversized-chat', userMessageIds: [user.id], userText: user.text
  });

  assert.equal(result.completed, true);
  const receipts = user._codexReceipts;
  assert.ok(new TextEncoder().encode(JSON.stringify(receipts)).byteLength <= 64 * 1024);
  assert.equal(receipts.omitted, true);
  assert.ok(receipts.omittedSources > 0);
  assert.equal(receipts.activities.length, 64);
  assert.equal(receipts.activities[0].activityId, 'wa_1');
  assert.equal(receipts.activities[63].activityId, 'wa_64');
  assert.ok(receipts.activities.every(activity => activity.phase === 'completed'));
});

test('Codex config JSON cancellation becomes canceled without sending Gateway or committing side effects', async () => {
  const caller = new AbortController();
  const user = { id: 'config-abort-user', role: 'user', text: '配置取消' };
  const store = { activeProject: 'codex-code-test', activeChat: 'config-abort-chat', projects: [{
    id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'config-abort-chat', messages: [user] }]
  }] };
  let jsonStarted = false;
  let gatewayCalls = 0;
  let commits = 0;
  const syncCalls = [];
  const codex = loadCodex({
    store,
    getModule: name => name === 'sync' ? { scheduleCodexMessageSync: (...args) => syncCalls.push(args) } : null,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'must not build' }), commitCodexResponse: async () => { commits += 1; } },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/codex/config')) {
        return {
          ok: true,
          json: () => {
            jsonStarted = true;
            return new Promise((resolve, reject) => {
              init.signal.addEventListener('abort', () => reject(new Error('config body aborted')), { once: true });
            });
          }
        };
      }
      gatewayCalls += 1;
      return responseFromChunks([]);
    }
  });

  const turn = codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'config-abort-chat', userMessageIds: [user.id], userText: user.text,
    signal: caller.signal
  });
  while (!jsonStarted) await new Promise(resolve => setTimeout(resolve, 0));
  caller.abort();

  await assert.rejects(() => turn, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(user._codexTurnStatus, 'canceled');
  assert.equal(gatewayCalls, 0);
  assert.equal(commits, 0);
  assert.ok(syncCalls.length > 0);
});

test('Codex frontend records activity/source receipts on the user message and keeps late sources associated', async () => {
  const sid = 'gs_' + '2'.repeat(64);
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'c'.repeat(64);
  const syncCalls = [];
  const store = {
    activeProject: 'codex-code-test', activeChat: 'receipt-chat',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [
      { id: 'receipt-chat', aiSettings: { webSearch: true }, messages: [{ id: 'receipt-user', role: 'user', text: '查资料' }] }
    ] }]
  };
  const codex = loadCodex({
    store,
    chatModule: {
      buildCodexPromptContext: () => ({ prompt: 'native prompt' }),
      commitCodexResponse: async () => {}
    },
    getModule: name => name === 'sync' ? { scheduleCodexMessageSync: (...args) => syncCalls.push(args) } : null,
    fetchImpl: async (url) => {
      if (url.endsWith('/api/codex/config')) return { ok: true, json: async () => ({ webMode: 'native' }) };
      return responseFromChunks([
        `event: session\ndata: {"sessionId":"${sid}"}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'unknown', outcome: 'unknown' })}\n\n`,
        `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'available' })}\n\n`,
        `event: source\ndata: ${JSON.stringify({ requestId, activityId, sourceId, displayUrl: 'https://example.org/a', redacted: true, title: '<b>来源</b>', refId: 'ref_1' })}\n\n`,
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });

  const result = await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'receipt-chat', userMessageIds: ['receipt-user'], userText: '查资料'
  });
  assert.equal(result.completed, true);
  const receipts = store.projects[0].chats[0].messages[0]._codexReceipts;
  assert.equal(receipts.activities.length, 1);
  assert.equal(receipts.activities[0].phase, 'completed');
  assert.equal(receipts.activities[0].sourceCards[0].sourceId, sourceId);
  assert.equal(receipts.activities[0].sourceCards[0].redacted, true);
  assert.ok(syncCalls.length > 0);
});

test('Codex zero-message failures and unknown EOFs sync terminal state and settle running receipts', async () => {
  async function runCase(streamChunks) {
    const sid = 'gs_' + Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64);
    const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
    const activityId = 'wa_1';
    const syncCalls = [];
    const user = { id: 'user-terminal', role: 'user', text: '查资料' };
    const store = { activeProject: 'codex-code-test', activeChat: 'terminal-chat', projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'terminal-chat', aiSettings: { webSearch: true }, messages: [user] }]
    }] };
    const codex = loadCodex({
      store,
      chatModule: { buildCodexPromptContext: () => ({ prompt: 'native prompt' }), commitCodexResponse: async () => {} },
      getModule: name => name === 'sync' ? { scheduleCodexMessageSync: (...args) => syncCalls.push(args) } : null,
      fetchImpl: async url => url.endsWith('/api/codex/config')
        ? { ok: true, json: async () => ({ webMode: 'native' }) }
        : responseFromChunks(streamChunks(sid, requestId, activityId))
    });
    return { codex, store, user, syncCalls };
  }

  const failed = await runCase(sid => [
    `event: session\ndata: {"sessionId":"${sid}"}\n\n`,
    'event: error\ndata: {"code":"CODEX_GATEWAY_FAILED"}\n\n'
  ]);
  await assert.rejects(() => failed.codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'terminal-chat', userMessageIds: ['user-terminal'], userText: '查资料' }));
  assert.equal(failed.user._codexTurnStatus, 'failed');
  assert.ok(failed.syncCalls.length > 0);

  const unknown = await runCase((_sid, requestId, activityId) => [
    'event: session\ndata: {"sessionId":"gs_' + '3'.repeat(64) + '"}\n\n',
    `event: activity\ndata: ${JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'unknown', outcome: 'unknown' })}\n\n`
  ]);
  let unknownError;
  await assert.rejects(() => unknown.codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'terminal-chat', userMessageIds: ['user-terminal'], userText: '查资料' }), error => { unknownError = error; return true; });
  assert.equal(unknownError.code, 'CODEX_GATEWAY_INCOMPLETE');
  assert.equal(unknown.user._codexTurnStatus, 'unknown');
  assert.equal(unknown.user._codexReceipts.activities[0].phase, 'interrupted');
  assert.equal(unknown.user._codexReceipts.activities[0].reason, 'turn_ended');
  assert.ok(unknown.syncCalls.length > 0);
});

test('Codex frontend requires a complete completion event and never dispatches an incomplete EOF event', async () => {
  const codex = loadCodex();
  const events = [];
  await assert.rejects(
    () => codex.consumeSse(responseFromChunks(['event: completion\ndata: {"status":"completed"}\n']), {
      onEvent: event => events.push(event)
    }),
    error => error.code === 'CODEX_GATEWAY_INCOMPLETE'
  );
  assert.deepEqual(events, []);
});

test('Codex frontend stream injects no browser credentials, uses same-origin route, and commits only after completion', async () => {
  const sid = 'gs_' + 'c'.repeat(64);
  const requests = [];
  const codex = loadCodex({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responseFromChunks([
        'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
        'event: message\ndata: {"text":"reply"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });
  const events = [];
  const result = await codex.stream({ prompt: 'hello', onEvent: event => events.push(event) });
  assert.equal(result.completed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://app.test/api/codex/stream');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { prompt: 'hello' });
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(events.map(event => event.type), ['session', 'message', 'completion']);
});

test('Codex session lifecycle keeps the original continuation session on failure and does not replay', async () => {
  const oldSession = 'gs_' + 'd'.repeat(64);
  const newSession = 'gs_' + 'e'.repeat(64);
  const values = new Map();
  const storage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); }
  };
  const requests = [];
  const codex = loadCodex({
    storage,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        return responseFromChunks([
          'event: session\ndata: {"sessionId":"' + newSession + '"}\n\n',
          'event: completion\ndata: {"status":"completed"}\n\n'
        ]);
      }
      return responseFromChunks([
        'event: error\ndata: {"code":"UNKNOWN_SESSION","detail":"private"}\n\n'
      ]);
    }
  });
  const key = codex.sessionKey('codex-gateway', 'codex-code-test', 'chat-1');
  await codex.runTurn({ projectId: 'codex-code-test', chatId: 'chat-1', prompt: 'first' });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(key))), { sessionId: newSession });
  await assert.rejects(() => codex.runTurn({ projectId: 'codex-code-test', chatId: 'chat-1', prompt: 'second' }), error => error.code === 'UNKNOWN_SESSION');
  assert.deepEqual(requests, [{ prompt: 'first' }, { prompt: 'second', sessionId: newSession }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(key))), { sessionId: newSession });
  assert.notEqual(oldSession, newSession);
});

test('Codex cancellation while reading an already-open SSE body is canceled, not failed', async () => {
  let requestSignal;
  let releaseRead;
  const states = [];
  const codex = loadCodex({
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader() {
            return {
              read() {
                return new Promise((resolve, reject) => {
                  releaseRead = () => reject(Object.assign(new Error('aborted while reading'), { name: 'AbortError' }));
                  requestSignal.addEventListener('abort', releaseRead, { once: true });
                });
              },
              async cancel() {},
              releaseLock() {}
            };
          }
        }
      };
    }
  });
  const caller = new AbortController();
  const pending = codex.runTurn({
    projectId: 'codex-code-test', chatId: 'chat-read-abort', prompt: 'wait',
    signal: caller.signal, onState: state => states.push(state)
  });
  while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 0));
  caller.abort();
  await assert.rejects(() => pending, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.deepEqual(states, ['canceled']);
});

test('invalidating a Codex turn prevents late completion and releases its controller', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-invalidate',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [
      { id: 'chat-invalidate', messages: [{ id: 'u-invalidate', role: 'user', text: '开始' }] }
    ] }]
  };
  const values = new Map();
  let releaseRead;
  let commits = 0;
  const codex = loadCodex({
    store,
    storage: {
      getItem: async key => values.get(key) || null,
      setItem: async (key, value) => values.set(key, value),
      removeItem: async key => values.delete(key)
    },
    chatModule: {
      buildCodexPromptContext: () => ({ prompt: 'prompt' }),
      commitCodexResponse: async () => { commits++; }
    },
    fetchImpl: async (_url, init) => {
      if (_url.endsWith('/api/codex/config')) return { ok: true, json: async () => ({ webMode: 'legacy' }) };
      return {
        ok: true, status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader() {
            return {
              read() {
                return new Promise((_resolve, reject) => {
                  releaseRead = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                  init.signal.addEventListener('abort', releaseRead, { once: true });
                });
              },
              async cancel() {}, releaseLock() {}
            };
          }
        }
      };
    }
  });
  const turn = codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'chat-invalidate', userMessageIds: ['u-invalidate'], userText: '开始' });
  while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 0));
  codex.invalidateAll();
  await assert.rejects(() => turn, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(commits, 0);
  assert.equal(await values.get(codex.sessionKey('codex-gateway', 'codex-code-test', 'chat-invalidate')), undefined);
});

test('a Codex turn holds the page lock across chats without canceling the original request', async () => {
  const stop = { style: {} };
  const controls = { style: {} };
  const send = { disabled: false };
  const typing = { innerHTML: '' };
  const store = {
    activeProject: 'codex-code-test',
    activeChat: 'chat-a',
    projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway', chats: [
        { id: 'chat-a', messages: [] }, { id: 'chat-b', messages: [] }
      ]
    }]
  };
  const openedReads = [];
  const codex = loadCodex({
    store,
    dom: { codexStopBtn: stop, codexControls: controls, chatSendBtn: send, chatTypingArea: typing },
    chatModule: {
      buildCodexPromptContext: () => ({ prompt: 'prompt' }),
      commitCodexResponse: async () => {}
    },
    fetchImpl: async (_url, init) => {
      if (_url.endsWith('/api/codex/config')) return { ok: true, json: async () => ({ webMode: 'legacy' }) };
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader() {
            return {
              read() {
                return new Promise((_resolve, reject) => {
                  const abort = () => reject(Object.assign(new Error('read aborted'), { name: 'AbortError' }));
                  openedReads.push({ signal: init.signal, abort });
                  init.signal.addEventListener('abort', abort, { once: true });
                });
              },
              async cancel() {},
              releaseLock() {}
            };
          }
        }
      };
    }
  });
  const abortA = new AbortController();
  const abortB = new AbortController();
  const turnA = codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'chat-a', userText: 'a', signal: abortA.signal });
  while (openedReads.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
  store.activeChat = 'chat-b';
  typing.innerHTML = 'new chat typing';
  const turnB = codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'chat-b', userText: 'b', signal: abortB.signal });
  await assert.rejects(() => turnB, error => error.code === 'BUSY');
  assert.equal(openedReads.length, 1);
  assert.equal(stop.style.display, '');
  abortA.abort();
  await assert.rejects(() => turnA, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(stop.style.display, 'none');
  assert.equal(typing.innerHTML, 'new chat typing');
});

test('a session write racing with start-new-session cannot restore the invalid mapping', async () => {
  const values = new Map();
  let setStarted;
  let releaseSet;
  const started = new Promise(resolve => { setStarted = resolve; });
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => {
      setStarted();
      await new Promise(resolve => { releaseSet = resolve; });
      values.set(key, value);
    },
    removeItem: async key => { values.delete(key); }
  };
  const sid = 'gs_' + 'f'.repeat(64);
  const codex = loadCodex({
    storage,
    fetchImpl: async () => responseFromChunks([
      'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
      'event: completion\ndata: {"status":"completed"}\n\n'
    ])
  });
  const key = codex.sessionKey('codex-gateway', 'codex-code-test', 'race-chat');
  const turn = codex.runTurn({ projectId: 'codex-code-test', chatId: 'race-chat', prompt: 'first' });
  await started;
  const remove = codex.startNewSession('codex-code-test', 'race-chat');
  releaseSet();
  await assert.rejects(() => turn, error => error.code === 'CODEX_GATEWAY_ABORTED');
  await remove;
  assert.equal(await storage.getItem(key), null);
});

test('Codex search turns commit only final integration messages', async () => {
  const sid = 'gs_' + '7'.repeat(64);
  const commits = [];
  const storageValues = new Map();
  const storage = {
    getItem: async key => storageValues.has(key) ? storageValues.get(key) : null,
    setItem: async (key, value) => storageValues.set(key, value),
    removeItem: async key => storageValues.delete(key)
  };
  const store = {
    activeProject: 'codex-code-test',
    activeChat: 'chat-actions',
    projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway',
      chats: [{ id: 'chat-actions', aiSettings: { webSearch: true }, messages: [
        { id: 'user-actions', role: 'user', text: '查资料' }
      ] }]
    }]
  };
  const chatModule = {
    buildCodexPromptContext: options => ({ prompt: options.continuation ? 'integration' : 'initial' }),
    commitCodexResponse: async options => commits.push(JSON.parse(JSON.stringify(options.assistantMessages.map(message => message.text))))
  };
  let postCount = 0;
  const codex = loadCodex({
    store, storage, chatModule,
    fetchImpl: async url => {
      if (url.endsWith('/api/codex/config')) return { ok: true, json: async () => ({ webMode: 'legacy' }) };
      if (url.endsWith('/api/search')) return { ok: true, json: async () => ({ results: '资料' }) };
      postCount++;
      return responseFromChunks(postCount === 1 ? [
        'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
        'event: message\ndata: {"text":"中间 [[DIARY:不应执行|calm|中间内容]] [[SEARCH:资料]]"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ] : [
        'event: message\ndata: {"text":"最终 [[TODO:应执行|2099-01-01T09:00Z]]"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });

  const result = await codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'chat-actions',
    userMessageIds: ['user-actions'], userText: '查资料'
  });

  assert.equal(result.completed, true);
  assert.deepEqual(commits, [['最终 [[TODO:应执行|2099-01-01T09:00Z]]']]);
});

test('stopping during Codex search aborts search and prevents integration POST', async () => {
  const sid = 'gs_' + '8'.repeat(64);
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-search-stop',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [
      { id: 'chat-search-stop', aiSettings: { webSearch: true }, messages: [
        { id: 'user-search-stop', role: 'user', text: '搜索' }
      ] }
    ] }]
  };
  const posts = [];
  let searchSignal;
  let releaseSearch;
  const codex = loadCodex({
    store,
    chatModule: { buildCodexPromptContext: () => ({ prompt: 'prompt' }), commitCodexResponse: async () => {} },
    fetchImpl: (url, init) => {
      if (url.endsWith('/api/codex/config')) return Promise.resolve({ ok: true, json: async () => ({ webMode: 'legacy' }) });
      if (url.endsWith('/api/search')) {
        searchSignal = init.signal;
        return new Promise((resolve, reject) => {
          releaseSearch = () => resolve({ ok: true, json: async () => ({ results: '资料' }) });
          init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      }
      posts.push(JSON.parse(init.body));
      return responseFromChunks([
        'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
        'event: message\ndata: {"text":"需要 [[SEARCH:资料]]"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });
  const turn = codex.sendChatTurn({
    projectId: 'codex-code-test', chatId: 'chat-search-stop',
    userMessageIds: ['user-search-stop'], userText: '搜索'
  });
  while (!searchSignal) await new Promise(resolve => setTimeout(resolve, 0));
  codex.cancelActive('codex-code-test', 'chat-search-stop');
  if (!searchSignal.aborted && releaseSearch) releaseSearch();

  await assert.rejects(() => turn, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(searchSignal.aborted, true);
  assert.equal(posts.length, 1);
});

test('Codex storage failure releases the request lock and allows a later send', async () => {
  let failStorage = true;
  const storage = {
    getItem: async () => {
      if (failStorage) throw new Error('storage unavailable');
      return null;
    },
    setItem: async () => {},
    removeItem: async () => {}
  };
  const sid = 'gs_' + '9'.repeat(64);
  const codex = loadCodex({
    storage,
    fetchImpl: async () => responseFromChunks([
      'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
      'event: completion\ndata: {"status":"completed"}\n\n'
    ])
  });
  await assert.rejects(
    () => codex.runTurn({ projectId: 'codex-code-test', chatId: 'storage-failure', prompt: 'first' }),
    /storage unavailable/
  );
  failStorage = false;
  const result = await codex.runTurn({ projectId: 'codex-code-test', chatId: 'storage-failure', prompt: 'second' });
  assert.equal(result.completed, true);
});

test('an invalid Codex session sidecar fails closed without leaking the lock', async () => {
  let sidecar = { unexpected: true };
  const sid = 'gs_' + '2'.repeat(64);
  const codex = loadCodex({
    storage: {
      getItem: async () => sidecar,
      setItem: async (_key, value) => { sidecar = value; },
      removeItem: async () => { sidecar = null; }
    },
    fetchImpl: async () => responseFromChunks([
      'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
      'event: completion\ndata: {"status":"completed"}\n\n'
    ])
  });
  await assert.rejects(() => codex.runTurn({ projectId: 'codex-code-test', chatId: 'invalid-sidecar', prompt: 'first' }),
    error => error.code === 'CODEX_INVALID_SESSION');
  sidecar = null;
  const result = await codex.runTurn({ projectId: 'codex-code-test', chatId: 'invalid-sidecar', prompt: 'second' });
  assert.equal(result.completed, true);
});

test('Codex prompt preflight does not accept dynamic context after a rejected body', async () => {
  let accepted = false;
  const codex = loadCodex({ fetchImpl: async () => { throw new Error('fetch should not run'); } });
  await assert.rejects(
    () => codex.stream({
      prompt: 'x'.repeat(32769),
      onPromptAccepted: () => { accepted = true; }
    }),
    error => error.code === 'CODEX_PROMPT_TOO_LARGE'
  );
  assert.equal(accepted, false);
});

test('not_connected does not claim a remote Codex deletion succeeded', async () => {
  const toasts = [];
  const store = {
    activeProject: 'codex-code-test', activeChat: 'empty-chat',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'empty-chat', messages: [] }] }]
  };
  const codex = loadCodex({
    store,
    toast: message => toasts.push(message),
    storage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, keys: async () => [] }
  });
  await codex.disconnectActiveSession();
  assert.equal(toasts.includes('Codex 远程会话已断开。'), false);
  assert.equal(toasts.includes('本设备没有待断开的 Codex 远程映射。'), true);
});

test('disconnect active session stays bound to the original chat across a switch', async t => {
  for (const outcome of ['success', 'failure']) {
    await t.test(outcome, async () => {
      const sidA = 'gs_' + '8'.repeat(64);
      const sidB = 'gs_' + '9'.repeat(64);
      const keyA = 'codex-session-v1:codex-gateway:codex-code-test:chat-disconnect-a';
      const keyB = 'codex-session-v1:codex-gateway:codex-code-test:chat-disconnect-b';
      const values = new Map([[keyA, { sessionId: sidA }], [keyB, { sessionId: sidB }]]);
      let releaseRead;
      const readWait = new Promise(resolve => { releaseRead = resolve; });
      let readReleased = false;
      const requests = [];
      const toasts = [];
      const storage = {
        getItem: async key => {
          if (key === keyA && !readReleased) await readWait;
          return values.get(key) || null;
        },
        setItem: async (key, value) => values.set(key, value),
        removeItem: async key => values.delete(key),
        keys: async () => Array.from(values.keys())
      };
      const store = {
        activeProject: 'codex-code-test', activeChat: 'chat-disconnect-a',
        projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [
          { id: 'chat-disconnect-a', messages: [] }, { id: 'chat-disconnect-b', messages: [] }
        ] }]
      };
      const codex = loadCodex({
        store,
        storage,
        toast: message => toasts.push(message),
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          const response = responseFromChunks([outcome === 'success' ? '{"status":"deleted"}' : '{"error":"CODEX_GATEWAY_UNAVAILABLE"}'], { 'content-type': 'application/json' });
          if (outcome === 'failure') { response.ok = false; response.status = 503; }
          return response;
        }
      });
      const disconnecting = codex.disconnectActiveSession();
      await new Promise(resolve => setTimeout(resolve, 0));
      store.activeChat = 'chat-disconnect-b';
      readReleased = true;
      releaseRead();
      await disconnecting;

      assert.equal(requests.length, 1);
      assert.match(requests[0].url, new RegExp(sidA));
      assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(keyB))), { sessionId: sidB });
      if (outcome === 'success') {
        assert.equal(await storage.getItem(keyA), null);
        assert.equal(toasts.includes('Codex 远程会话已断开。'), true);
      } else {
        const pending = await codex.listPendingDisconnects();
        assert.deepEqual(JSON.parse(JSON.stringify(pending.map(entry => [entry.chatId, entry.sessionId]))), [['chat-disconnect-a', sidA]]);
      }
    });
  }
});

test('start-new-session keeps its original chat context across a switch', async () => {
  const values = new Map();
  let releaseRemove;
  const removeWait = new Promise(resolve => { releaseRemove = resolve; });
  let removeStarted = false;
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => { removeStarted = true; await removeWait; values.delete(key); },
    keys: async () => Array.from(values.keys())
  };
  const chatA = { id: 'chat-new-a', messages: [], _codexSessionInvalid: true };
  const chatB = { id: 'chat-new-b', messages: [], _codexSessionInvalid: true };
  const store = {
    activeProject: 'codex-code-test', activeChat: chatA.id,
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [chatA, chatB] }]
  };
  const codex = loadCodex({ store, storage });
  const starting = codex.startNewActiveSession();
  while (!removeStarted) await new Promise(resolve => setTimeout(resolve, 0));
  store.activeChat = chatB.id;
  releaseRemove();
  await starting;
  assert.equal(chatA._codexSessionInvalid, false);
  assert.equal(chatB._codexSessionInvalid, true);
});

test('multiple pending disconnect sidecars remain separately visible and failed manual processing preserves all', async () => {
  const sidA = 'gs_' + 'a'.repeat(64);
  const sidB = 'gs_' + 'b'.repeat(64);
  const values = new Map([
    ['codex-pending-disconnect-v1:codex-gateway:codex-code-test:chat-a', { sessionId: sidA }],
    ['codex-pending-disconnect-v1:codex-gateway:codex-code-test:chat-b', { sessionId: sidB }]
  ]);
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
    keys: async () => Array.from(values.keys())
  };
  const codex = loadCodex({
    storage,
    fetchImpl: async () => {
      const response = responseFromChunks(['{\"error\":\"SESSION_ACTIVE\"}'], { 'content-type': 'application/json' });
      response.ok = false;
      response.status = 409;
      return response;
    }
  });
  const entries = await codex.listPendingDisconnects();
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(entry => entry.chatId))), ['chat-a', 'chat-b']);
  const results = await codex.disconnectPendingSessions();
  assert.deepEqual(JSON.parse(JSON.stringify(results.map(result => result.status))), ['SESSION_ACTIVE', 'SESSION_ACTIVE']);
  assert.equal(values.size, 2);
});

test('pending disconnect targets its selected session and preserves the active session', async () => {
  const sidA = 'gs_' + 'a'.repeat(64);
  const sidB = 'gs_' + 'b'.repeat(64);
  const activeKey = 'codex-session-v1:codex-gateway:codex-code-test:chat-target';
  const pendingKey = 'codex-pending-disconnect-v1:codex-gateway:codex-code-test:chat-target:' + sidA;
  const values = new Map([
    [activeKey, { sessionId: sidB }],
    [pendingKey, { sessionId: sidA }]
  ]);
  const requests = [];
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
    keys: async () => Array.from(values.keys())
  };
  const codex = loadCodex({
    storage,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responseFromChunks(['{"status":"deleted"}'], { 'content-type': 'application/json' });
    }
  });

  const results = await codex.disconnectPendingSessions({ projectId: 'codex-code-test', chatId: 'chat-target' });
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ projectId: 'codex-code-test', chatId: 'chat-target', status: 'deleted' }]);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, new RegExp(sidA));
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(activeKey))), { sessionId: sidB });
  assert.equal(await storage.getItem(pendingKey), null);
});

test('delayed delete and unknown-session responses do not remove a newer session', async t => {
  for (const errorCode of [null, 'UNKNOWN_SESSION']) {
    await t.test(errorCode || 'deleted', async () => {
      const sidA = 'gs_' + 'c'.repeat(64);
      const sidB = 'gs_' + 'd'.repeat(64);
      const activeKey = 'codex-session-v1:codex-gateway:codex-code-test:chat-race-' + (errorCode || 'deleted');
      const values = new Map([[activeKey, { sessionId: sidA }]]);
      let releaseDelete;
      const deleteWait = new Promise(resolve => { releaseDelete = resolve; });
      const storage = {
        getItem: async key => values.get(key) || null,
        setItem: async (key, value) => values.set(key, value),
        removeItem: async key => values.delete(key),
        keys: async () => Array.from(values.keys())
      };
      const codex = loadCodex({
        storage,
        fetchImpl: async (_url, init) => {
          if (init.method === 'DELETE') {
            await deleteWait;
            if (errorCode) {
              const response = responseFromChunks(['{"error":"UNKNOWN_SESSION"}'], { 'content-type': 'application/json' });
              response.ok = false;
              response.status = 404;
              return response;
            }
            return responseFromChunks(['{"status":"deleted"}'], { 'content-type': 'application/json' });
          }
          return responseFromChunks([
            'event: session\ndata: {"sessionId":"' + sidB + '"}\n\n',
            'event: completion\ndata: {"status":"completed"}\n\n'
          ]);
        }
      });

      const deletion = codex.disconnect({
        projectId: 'codex-code-test', chatId: activeKey.split(':').pop(), sessionId: sidA
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      await codex.startNewSession('codex-code-test', activeKey.split(':').pop());
      await codex.runTurn({ projectId: 'codex-code-test', chatId: activeKey.split(':').pop(), prompt: 'new session' });
      releaseDelete();
      if (errorCode) await assert.rejects(deletion, error => error.code === errorCode);
      else await deletion;
      assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(activeKey))), { sessionId: sidB });
    });
  }
});

test('an old delete failure does not overwrite a newer pending session', async () => {
  const sidA = 'gs_' + 'e'.repeat(64);
  const sidB = 'gs_' + 'f'.repeat(64);
  const chatId = 'chat-failure-race';
  const activeKey = 'codex-session-v1:codex-gateway:codex-code-test:' + chatId;
  const pendingBKey = 'codex-pending-disconnect-v1:codex-gateway:codex-code-test:' + chatId + ':' + sidB;
  const values = new Map([[activeKey, { sessionId: sidA }]]);
  let releaseDelete;
  const deleteWait = new Promise(resolve => { releaseDelete = resolve; });
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
    keys: async () => Array.from(values.keys())
  };
  const codex = loadCodex({
    storage,
    fetchImpl: async (_url, init) => {
      await deleteWait;
      const response = responseFromChunks(['{"error":"CODEX_GATEWAY_UNAVAILABLE"}'], { 'content-type': 'application/json' });
      response.ok = false;
      response.status = 503;
      return response;
    }
  });
  const deletion = codex.disconnect({ projectId: 'codex-code-test', chatId, sessionId: sidA });
  await new Promise(resolve => setTimeout(resolve, 0));
  await codex.startNewSession('codex-code-test', chatId);
  await storage.setItem(pendingBKey, { sessionId: sidB });
  releaseDelete();
  await assert.rejects(deletion, error => error.code === 'CODEX_GATEWAY_UNAVAILABLE');
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(pendingBKey))), { sessionId: sidB });
  const pendingEntries = await codex.listPendingDisconnects();
  assert.deepEqual(JSON.parse(JSON.stringify(pendingEntries.map(entry => entry.sessionId))), [sidB, sidA]);
});

test('multiple pending sessions for one chat can be processed independently', async () => {
  const sidA = 'gs_' + '1'.repeat(64);
  const sidB = 'gs_' + '2'.repeat(64);
  const chatId = 'chat-multiple-pending';
  const keyA = 'codex-pending-disconnect-v1:codex-gateway:codex-code-test:' + chatId + ':' + sidA;
  const keyB = 'codex-pending-disconnect-v1:codex-gateway:codex-code-test:' + chatId + ':' + sidB;
  const values = new Map([[keyA, { sessionId: sidA }], [keyB, { sessionId: sidB }]]);
  const requests = [];
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
    keys: async () => Array.from(values.keys())
  };
  const codex = loadCodex({
    storage,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith(sidA)) return responseFromChunks(['{"status":"deleted"}'], { 'content-type': 'application/json' });
      const response = responseFromChunks(['{"error":"SESSION_ACTIVE"}'], { 'content-type': 'application/json' });
      response.ok = false;
      response.status = 409;
      return response;
    }
  });
  const results = await codex.disconnectPendingSessions({ projectId: 'codex-code-test', chatId });
  assert.deepEqual(JSON.parse(JSON.stringify(results.map(result => result.status))), ['deleted', 'SESSION_ACTIVE']);
  assert.deepEqual(JSON.parse(JSON.stringify(requests.map(request => request.url.endsWith(sidA) ? sidA : sidB))), [sidA, sidB]);
  assert.equal(await storage.getItem(keyA), null);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(keyB))), { sessionId: sidB });
});

test('invalidating one Codex chat does not remove another chat session or request', async () => {
  const sidB = 'gs_' + '3'.repeat(64);
  const keyA = 'codex-session-v1:codex-gateway:codex-code-test:chat-delete-a';
  const keyB = 'codex-session-v1:codex-gateway:codex-code-test:chat-delete-b';
  const values = new Map([[keyA, { sessionId: 'gs_' + '4'.repeat(64) }], [keyB, { sessionId: sidB }]]);
  let releaseRead;
  const readWait = new Promise(resolve => { releaseRead = resolve; });
  let requestSignal;
  const storage = {
    getItem: async key => values.get(key) || null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
    keys: async () => Array.from(values.keys())
  };
  const codex = loadCodex({
    storage,
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return {
        ok: true, status: 200,
        headers: { get: () => 'text/event-stream' },
        body: { getReader: () => ({ read: () => readWait, cancel: async () => {}, releaseLock: () => {} }) }
      };
    }
  });
  const running = codex.runTurn({ projectId: 'codex-code-test', chatId: 'chat-delete-b', prompt: 'keep running' });
  await new Promise(resolve => setTimeout(resolve, 0));
  codex.invalidateChat('codex-code-test', 'chat-delete-a');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requestSignal.aborted, false);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(keyB))), { sessionId: sidB });
  codex.cancelActive('codex-code-test', 'chat-delete-b');
  releaseRead({ done: true, value: undefined });
  await assert.rejects(running, error => error.code === 'CODEX_GATEWAY_ABORTED');
});
