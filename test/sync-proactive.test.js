const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSyncModule(store, responses, requestedUrls, renderCalls = [], requestedRequests = []) {
  const source = fs.readFileSync('public/js/sync.js', 'utf8');
  let chatTimeModule;
  vm.runInNewContext(fs.readFileSync('public/js/chat-time.js', 'utf8'), {
    AppCore: { register: (_name, module) => { chatTimeModule = module; } }
  });
  const sandbox = {
    console,
    Date,
    Promise,
    encodeURIComponent,
    fetch: (url, init) => {
      requestedUrls.push(url);
      requestedRequests.push({ url, init });
      const response = responses.shift();
      const body = Array.isArray(response) ? { messages: response } : (response || { messages: [] });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    },
    renderChatMessages: () => { renderCalls.push(true); },
    toLocalDisplayTime: iso => iso,
    MemoryModule: { getCML: () => null, getCoreOverview: () => null },
    getActiveProject: () => store.projects.find(project => project.id === store.activeProject),
    getActiveChatObj: () => store.projects.flatMap(project => project.chats).find(chat => chat.id === store.activeChat),
    getActiveApiConfig: () => ({ apiKey: 'key', endpoint: 'https://api.example/v1', model: 'test-model', enabled: true }),
    getAIName: () => '暖伴',
    getActiveChatAiSettings: () => ({}),
    AppCore: {
      BACKEND_URL: 'https://backend.test',
      getStore: () => store,
      getActiveProject: () => store.projects.find(project => project.id === store.activeProject),
      getActiveChatObj: () => store.projects.flatMap(project => project.chats).find(chat => chat.id === store.activeChat),
      fmtDate: () => ({ iso: '2026-10-04' }),
      getModule: () => null,
      saveStore: () => {}
    }
  };
  sandbox.ChatTimeModule = chatTimeModule;
  sandbox.AppCore.register = (name, module) => { sandbox[name + 'Module'] = module; };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/sync.js' });
  return sandbox.SyncModule;
}

function waitForAsyncPolling() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

test('pullChatMessages restores a closed-page proactive message with trigger time and no duplicate', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [] }] }]
  };
  const cloudRows = [{
    projectId: 'p1', windowId: 'c1', messageId: 'proactive_evt_42',
    role: 'assistant', content: '页面关闭时生成的消息',
    createdAt: '2026-09-01T03:04:05.000Z',
    metadata: { proactive: true, action_type: 'message', drive_key: 'resonance' }
  }];
  const requestedUrls = [];
  const sync = loadSyncModule(store, [cloudRows, cloudRows], requestedUrls);

  await sync.pullChatMessages('p1');
  await sync.pullChatMessages('p1');

  const chatMessages = store.projects[0].chats[0].messages;
  assert.equal(chatMessages.length, 1);
  assert.equal(chatMessages[0].id, 'proactive_evt_42');
  assert.equal(chatMessages[0].text, '页面关闭时生成的消息');
  assert.equal(chatMessages[0].createdAt, '2026-09-01T03:04:05.000Z');
  assert.equal(chatMessages[0].time, '11:04');
  assert.match(requestedUrls[0], /targetWindowId=c1/);
  assert.match(requestedUrls[1], /since=/);
});

test('pullChatMessages keeps an untrusted legacy message in place when merging cloud history', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [
      { id: 'local-late', role: 'system', text: '确认欲', time: '21:00' }
    ] }] }]
  };
  const cloudRows = [{
    projectId: 'p1', windowId: 'c1', messageId: 'cloud-early',
    role: 'system', content: '猫砂盆好像需要铲一铲',
    createdAt: '2026-10-04T20:00:00.000', metadata: {}
  }];
  const sync = loadSyncModule(store, [cloudRows], []);

  await sync.pullChatMessages('p1');

  assert.deepEqual(store.projects[0].chats[0].messages.map(message => message.text), [
    '确认欲', '猫砂盆好像需要铲一铲'
  ]);
});

test('pullChatMessages inserts trusted cloud history around existing trusted messages and preserves ties', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [
      { id: 'local-late', role: 'system', text: '晚', date: '2026-10-04', time: '21:00' },
      { id: 'legacy', role: 'system', text: '旧消息', time: '21:30' }
    ] }] }]
  };
  const rows = [
    { projectId: 'p1', windowId: 'c1', messageId: 'cloud-early', role: 'assistant', content: '早', createdAt: '2026-10-04T20:00:00.000', metadata: {} },
    { projectId: 'p1', windowId: 'c1', messageId: 'cloud-tie-a', role: 'assistant', content: '同刻A', createdAt: '2026-10-04T21:00:00.000', metadata: {} },
    { projectId: 'p1', windowId: 'c1', messageId: 'cloud-tie-b', role: 'assistant', content: '同刻B', createdAt: '2026-10-04T21:00:00.000', metadata: {} }
  ];
  const sync = loadSyncModule(store, [rows], []);

  await sync.pullChatMessages('p1');

  assert.deepEqual(store.projects[0].chats[0].messages.map(message => message.id), [
    'cloud-early', 'local-late', 'cloud-tie-a', 'cloud-tie-b', 'legacy'
  ]);
});

test('pullChatMessages keeps sessions separate and a repeated pull does not reorder or duplicate', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [
      { id: 'c1', messages: [{ id: 'c1-old', role: 'user', text: '一', date: '2026-10-04', time: '20:00' }] },
      { id: 'c2', messages: [{ id: 'c2-old', role: 'user', text: '二', date: '2026-10-05', time: '20:00' }] }
    ] }]
  };
  const rows = [
    { projectId: 'p1', windowId: 'c2', messageId: 'c2-new', role: 'assistant', content: '只属于二', createdAt: '2026-10-05T21:00:00.000', metadata: {} }
  ];
  const sync = loadSyncModule(store, [rows, rows], []);

  await sync.pullChatMessages('p1');
  const firstOrder = store.projects[0].chats.map(chat => chat.messages.map(message => message.id));
  await sync.pullChatMessages('p1');

  assert.deepEqual(store.projects[0].chats.map(chat => chat.messages.map(message => message.id)), firstOrder);
  assert.deepEqual(firstOrder, [['c1-old'], ['c2-old', 'c2-new']]);
});

test('pollSystemEvents applies canonical status events while restoring the proactive message', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [] }], desireSystem: { drives: {} } }]
  };
  const renderCalls = [];
  const sync = loadSyncModule(store, [
    { events: [{ id: 42, type: 'status', content: '等你回家', timestamp: '2026-10-04T00:00:00.000Z', chatId: 'c1' }] },
    { messages: [{
      projectId: 'p1', windowId: 'c1', messageId: 'proactive_evt_42',
      role: 'assistant', content: '有一点想和你说',
      createdAt: '2026-10-04T00:00:00.000Z', metadata: { proactive: true }
    }] }
  ], [], renderCalls);

  sync.pollSystemEvents();
  await waitForAsyncPolling();

  const project = store.projects[0];
  assert.equal(project._aiStatus, '等你回家');
  assert.equal(project._aiStatusChanged, true);
  assert.equal(project.chats[0].messages[0].text, '有一点想和你说');
  assert.ok(renderCalls.length > 0);
});

test('Codex cloud merge inserts new messages without globally reordering existing barriers', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-1',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'chat-1', messages: [
      { id: 'known-late', role: 'user', text: 'late', createdAt: '2026-10-06T21:00:00.000Z' },
      { id: 'legacy', role: 'system', text: 'legacy', time: '20:00' },
      { id: 'divider', role: 'system', contentType: 'dateDivider', text: 'divider', createdAt: '2026-10-06T20:00:00.000Z' },
      { id: 'known-early', role: 'ai', text: 'early', createdAt: '2026-10-06T20:30:00.000Z' }
    ] }] }]
  };
  const rows = [{
    projectId: 'codex-code-test', windowId: 'chat-1', messageId: 'cloud-new', role: 'assistant',
    content: 'new', createdAt: '2026-10-06T20:45:00.000Z',
    metadata: { runtime: 'codex-gateway', turnId: 't', turnStatus: 'completed', messageIndex: 0, updatedAt: '2026-10-06T20:45:00.000Z' }
  }];
  const sync = loadSyncModule(store, [rows], []);

  await sync.pullChatMessages('codex-code-test');

  assert.deepEqual(store.projects[0].chats[0].messages.map(message => message.id), [
    'cloud-new', 'known-late', 'legacy', 'divider', 'known-early'
  ]);
});

test('Codex cloud merge preserves messageIndex order for same-turn equal timestamps', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-1',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'chat-1', messages: [] }] }]
  };
  const rows = [1, 0].map(index => ({
    projectId: 'codex-code-test', windowId: 'chat-1', messageId: index === 1 ? 'turn-a' : 'turn-z',
    role: 'assistant', content: 'message-' + index, createdAt: '2026-10-06T20:00:00.000Z',
    metadata: { runtime: 'codex-gateway', turnId: 'turn-1', turnStatus: 'completed', messageIndex: index, updatedAt: '2026-10-06T20:00:00.000Z' }
  }));
  const sync = loadSyncModule(store, [rows], []);

  await sync.pullChatMessages('codex-code-test');

  assert.deepEqual(store.projects[0].chats[0].messages.map(message => message.id), ['turn-z', 'turn-a']);
});

test('pollSystemEvents keeps historical ai_status_change events readable', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [] }], desireSystem: { drives: {} } }]
  };
  const sync = loadSyncModule(store, [
    { events: [{ id: 43, type: 'ai_status_change', content: '忙着呢', timestamp: '2026-10-04T00:00:00.000Z', chatId: 'c1' }] },
    { messages: [] }
  ], []);

  sync.pollSystemEvents();
  await waitForAsyncPolling();

  assert.equal(store.projects[0]._aiStatus, '忙着呢');
  assert.equal(store.projects[0]._aiStatusChanged, true);
});

test('reconcileFromBackend hydrates a changed AI status and refreshes the active view', async () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', chats: [{ id: 'c1', messages: [] }], _aiStatus: '', desireSystem: { drives: {} } }]
  };
  const renderCalls = [];
  const sync = loadSyncModule(store, [
    { config: { enabled: true, _aiStatus: '等你回家' } }
  ], [], renderCalls);

  await sync.reconcileFromBackend();

  assert.equal(store.projects[0]._aiStatus, '等你回家');
  assert.equal(store.projects[0]._aiStatusChanged, true);
  assert.ok(renderCalls.length > 0);
});

test('routine project config sync does not send backend-owned AI status', () => {
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{
      id: 'p1',
      _aiStatus: '',
      preference: '',
      apiConfig: { apiKey: 'key', endpoint: 'https://api.example/v1', model: 'test-model', enabled: true },
      chats: [{ id: 'c1', messages: [] }]
    }]
  };
  const requestedRequests = [];
  const sync = loadSyncModule(store, [], [], [], requestedRequests);

  sync.syncProjectConfigToBackend();

  const body = JSON.parse(requestedRequests[0].init.body);
  assert.equal(body.config._aiStatus, undefined);
});
