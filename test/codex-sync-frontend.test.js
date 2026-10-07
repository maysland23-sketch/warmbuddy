const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSync(store, fetchImpl) {
  const timeSource = fs.readFileSync('public/js/chat-time.js', 'utf8');
  const source = fs.readFileSync('public/js/sync.js', 'utf8');
  let module;
  const modules = {};
  const sandbox = {
    console, Date, Promise, encodeURIComponent, URL,
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

function makeStore(messages) {
  return {
    activeProject: 'codex-code-test', activeChat: 'chat-1',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'chat-1', messages }] }]
  };
}

test('Codex sync keeps a newer dirty status after an old synced-zero response', async () => {
  const message = {
    id: 'm1', role: 'ai', text: 'running', createdAt: '2026-10-06T00:00:00.000Z',
    _codexRuntime: 'codex-gateway', _codexTurnId: 't1', _codexTurnStatus: 'running',
    _codexVersion: 1, _codexUpdatedAt: '2026-10-06T00:00:01.000Z', _codexWriterId: 'writer-a',
    _synced: false, _syncDirty: true
  };
  const store = makeStore([message]);
  let release;
  const sync = loadSync(store, () => new Promise(resolve => {
    release = () => resolve({ ok: true, json: async () => ({ synced: 0 }) });
  }));
  const upload = sync.syncCodexMessagesToBackend('codex-code-test', 'chat-1');
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  message.text = 'completed';
  message._codexTurnStatus = 'completed';
  message._codexVersion = 2;
  message._codexUpdatedAt = '2026-10-06T00:00:02.000Z';
  message._syncDirty = true;
  release();
  await upload;

  assert.equal(message._synced, false);
  assert.equal(message._syncDirty, true);
});

test('Codex sync keeps marker-cleaned text dirty after acknowledging the uploaded terminal snapshot', async () => {
  const message = {
    id: 'm-clean', role: 'ai', text: '完成 [[STATUS:专注中]]', createdAt: '2026-10-06T00:00:00.000Z',
    _codexRuntime: 'codex-gateway', _codexTurnId: 't-clean', _codexTurnStatus: 'completed',
    _codexVersion: 2, _codexUpdatedAt: '2026-10-06T00:00:02.000Z', _codexWriterId: 'writer-a',
    _synced: false, _syncDirty: true
  };
  const store = makeStore([message]);
  let release;
  const sync = loadSync(store, () => new Promise(resolve => {
    release = () => resolve({ ok: true, json: async () => ({ synced: 1, syncedMessageIds: ['m-clean'] }) });
  }));
  const upload = sync.syncCodexMessagesToBackend('codex-code-test', 'chat-1');
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  message.text = '完成';
  message._codexVersion = 3;
  message._codexUpdatedAt = '2026-10-06T00:00:03.000Z';
  message._syncDirty = true;
  release();
  await upload;

  assert.equal(message._synced, false);
  assert.equal(message._syncDirty, true);
});

test('Codex sync marks only server-confirmed message IDs in a partial response', async () => {
  const messages = [1, 2].map(index => ({
    id: 'm' + index, role: 'ai', text: 'message-' + index, createdAt: '2026-10-06T00:00:0' + index + '.000Z',
    _codexRuntime: 'codex-gateway', _codexTurnId: 't1', _codexTurnStatus: 'completed',
    _codexVersion: 1, _codexUpdatedAt: '2026-10-06T00:00:0' + index + '.000Z', _codexWriterId: 'writer-a',
    _synced: false, _syncDirty: true
  }));
  const store = makeStore(messages);
  const sync = loadSync(store, async () => ({
    ok: true,
    json: async () => ({ synced: 1, syncedMessageIds: ['m1'] })
  }));

  await sync.syncCodexMessagesToBackend('codex-code-test', 'chat-1');

  assert.equal(messages[0]._synced, true);
  assert.equal(messages[0]._syncDirty, false);
  assert.equal(messages[1]._synced, false);
  assert.equal(messages[1]._syncDirty, true);
});

test('Codex conversation pagination continues beyond the former 2000-row cap', async () => {
  const total = 2001;
  const allRows = Array.from({ length: total }, (_, index) => ({
    projectId: 'codex-code-test', windowId: 'chat-1', messageId: 'cloud-' + index,
    role: 'assistant', content: 'message-' + index,
    createdAt: new Date(2026, 9, 6, 0, 0, 0, index).toISOString(),
    metadata: {
      runtime: 'codex-gateway', turnId: 't-' + index, turnStatus: 'completed',
      messageIndex: 0, updatedAt: new Date(2026, 9, 6, 0, 0, 0, index).toISOString()
    }
  }));
  const store = makeStore([]);
  let calls = 0;
  const sync = loadSync(store, async url => {
    calls++;
    const cursor = Number(new URL(url).searchParams.get('cursor') || 0);
    const rows = allRows.slice(cursor, cursor + 100);
    return {
      ok: true,
      json: async () => ({ messages: rows, nextCursor: rows.length === 100 ? String(cursor + rows.length) : null })
    };
  });

  await sync.pullCodexConversationMessages('codex-code-test');

  assert.equal(store.projects[0].chats[0].messages.length, total);
  assert.equal(calls, 21);
  assert.equal(store.projects[0].chats[0].messages.at(-1).id, 'cloud-2000');
});
