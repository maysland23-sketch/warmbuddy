const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeElement(overrides = {}) {
  return Object.assign({
    value: '',
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    focus() {},
    setSelectionRange() {}
  }, overrides);
}

function loadChatModule(store, options = {}) {
  const sourcePath = 'public/js/chat.js';
  let module;
  const dom = Object.assign({
    projectList: makeElement(),
    currentProjectLabel: makeElement(),
    chatMessages: makeElement(),
    chatInput: makeElement(),
    chatTypingArea: makeElement(),
    newChatProjId: makeElement(),
    newChatNameInput: makeElement()
  }, options.dom || {});
  const sandbox = {
    console,
    Promise,
    Date,
    Math,
    URL,
    setTimeout,
    clearTimeout,
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) { return dom[id] || null; },
      querySelectorAll() { return []; }
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    syncProjectMemories() {},
    flushMemoryFile() {},
    writeMemoryFile() {},
    resolveArtifactRefs: text => text,
    getAIName: () => 'warmbuddy',
    MemoryModule: {
      getCML: () => ({ aiEmotionalMemories: [], userStarredMemories: [] }),
      getCoreOverview: () => null
    },
    ChatTimeModule: { createMessage: fields => fields, getTimeInfo: () => null },
    AppCore: {
      USER_NAME: 'mays',
      BACKEND_URL: '',
      getStore: () => store,
      getProjectById: id => store.projects.find(project => project.id === id) || null,
      getActiveProject: () => store.projects.find(project => project.id === store.activeProject) || null,
      getActiveChatObj: () => {
        if (options.getActiveChatObj) return options.getActiveChatObj(store);
        const project = store.projects.find(item => item.id === store.activeProject);
        return project && project.chats.find(chat => chat.id === store.activeChat) || null;
      },
      getActiveApiConfig: () => ({ enabled: true }),
      getActiveChatAiSettings: () => ({ autoDateTime: true, autoWeather: false, webSearch: false }),
      getModule: () => null,
      fmtDate: () => ({ iso: '2026-11-08', md: 'Nov 08' }),
      nowTime: () => '12:00',
      daysBetween: () => 1,
      generateMsgId: () => 'generated',
      gid: prefix => prefix + 'generated',
      saveStore() {},
      $: id => dom[id] || null,
      escapeHtml: value => String(value == null ? '' : value),
      register: (_name, value) => { module = value; }
    },
    UIModule: { toast() {}, closeModal() {} }
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, { filename: sourcePath });
  return module;
}

test('same-day inheritance selects the latest complete interaction time', () => {
  const project = {
    id: 'p1',
    chats: [
      { id: 'older', lastConversationDate: '2026-11-08', lastInteractionTime: '2026-11-08T09:00:00.000Z', messages: [{ role: 'user', text: 'older' }] },
      { id: 'newer', lastConversationDate: '2026-11-08', lastInteractionTime: '2026-11-08T11:00:00.000Z', messages: [{ role: 'user', text: 'newer' }] }
    ]
  };
  const module = loadChatModule({ activeProject: 'p1', activeChat: 'older', projects: [project] });

  assert.equal(module.selectWindowInheritanceSource(project, 'new-target').id, 'newer');
});

function makeProjectChats() {
  return [
    {
      id: 'current', name: 'current', sharedMemoryIds: [], chatTokens: 0,
      lastConversationDate: '2026-11-08',
      lastInteractionTime: '2026-11-08T12:00:00.000Z',
      messages: [{ id: 'current-message', role: 'user', text: 'current', createdAt: '2026-11-08T12:00:00.000Z' }]
    },
    {
      id: 'older', name: 'older', sharedMemoryIds: [], chatTokens: 0,
      lastConversationDate: '2026-11-08',
      lastInteractionTime: '2026-11-08T09:00:00.000Z',
      messages: [{ id: 'older-message', role: 'user', text: 'older', createdAt: '2026-11-08T09:00:00.000Z' }]
    },
    {
      id: 'newer', name: 'newer', sharedMemoryIds: [], chatTokens: 0,
      lastConversationDate: '2026-11-08',
      lastInteractionTime: '2026-11-08T11:00:00.000Z',
      messages: [{ id: 'newer-message', role: 'user', text: 'newer', createdAt: '2026-11-08T11:00:00.000Z' }]
    },
    {
      id: 'empty', name: 'empty', sharedMemoryIds: [], chatTokens: 0,
      lastConversationDate: '2026-11-08', lastInteractionTime: '2026-11-08T23:00:00.000Z', messages: []
    }
  ];
}

function makeStore(chats, activeChat) {
  return {
    activeProject: 'p1', activeChat, todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [{
      id: 'p1', name: 'Project', preference: '', memories: [],
      apiConfig: { enabled: true }, chats
    }]
  };
}

test('source selection excludes current and empty windows without mutating chat order or messages', () => {
  const chats = makeProjectChats();
  const originalIds = chats.map(chat => chat.id);
  const originalMessages = JSON.parse(JSON.stringify(chats.map(chat => chat.messages)));
  const module = loadChatModule(makeStore(chats, 'current'));

  assert.equal(module.selectWindowInheritanceSource({ chats }, 'current').id, 'newer');
  assert.deepEqual(chats.map(chat => chat.id), originalIds);
  assert.deepEqual(chats.map(chat => chat.messages), originalMessages);
});

test('missing or invalid complete times use deterministic conservative fallbacks', () => {
  const chats = [
    { id: 'first', lastConversationDate: '2026-11-08', lastInteractionTime: 1130, messages: [{ role: 'user', text: 'first' }] },
    { id: 'second', lastConversationDate: '2026-11-08', lastInteractionTime: 'not-a-time', messages: [{ role: 'user', text: 'second' }] }
  ];
  const module = loadChatModule(makeStore(chats, 'none'));
  assert.equal(module.selectWindowInheritanceSource({ chats }, 'none').id, 'first');

  chats[1].messages[0].createdAt = '2026-11-08T12:00:00.000Z';
  assert.equal(module.selectWindowInheritanceSource({ chats }, 'none').id, 'second');

  chats[0].lastConversationDate = '2026-11-09';
  chats[1].lastConversationDate = '2026-11-09';
  chats[0].lastInteractionTime = '2026-02-31T12:00:00.000Z';
  chats[0].messages[0].createdAt = '2026-11-08T12:00:00.000Z';
  chats[1].messages[0].createdAt = '2026-11-08T12:00:00.000Z';
  assert.equal(module.selectWindowInheritanceSource({ chats }, 'none').id, 'first');
});

test('saveChatWithMemories uses the shared source rule for same-day windows', () => {
  const chats = makeProjectChats();
  const store = makeStore(chats, 'current');
  const dom = {
    newChatProjId: makeElement({ value: 'p1' }),
    newChatNameInput: makeElement({ value: 'new window' })
  };
  const module = loadChatModule(store, { dom });

  module.saveChatWithMemories();

  const created = store.projects[0].chats[store.projects[0].chats.length - 1];
  assert.equal(created.messages[1]._inheritedFromWindow, 'current');
});

test('sendMessage uses the same source rule when it creates a missing active window', async () => {
  const chats = makeProjectChats();
  const store = makeStore(chats, 'missing-active-chat');
  const dom = { chatInput: makeElement({ value: '/help' }) };
  const module = loadChatModule(store, { dom });

  await module.sendMessage();

  const created = store.projects[0].chats[store.projects[0].chats.length - 1];
  assert.equal(created.messages[1]._inheritedFromWindow, 'current');
});

test('saveChatWithMemories inherits the only old active window', () => {
  const old = makeProjectChats()[0];
  const store = makeStore([old], old.id);
  const module = loadChatModule(store, {
    dom: {
      newChatProjId: makeElement({ value: 'p1' }),
      newChatNameInput: makeElement({ value: 'new window' })
    }
  });

  module.saveChatWithMemories();

  const created = store.projects[0].chats[store.projects[0].chats.length - 1];
  assert.equal(created.messages[1]._inheritedFromWindow, old.id);
});

test('handoff-only messages cannot outrank a real conversation window', () => {
  const chats = [
    {
      id: 'real', lastConversationDate: '2026-11-08', lastInteractionTime: null,
      messages: [{ role: 'user', text: 'real conversation', createdAt: '2026-11-08T09:00:00.000Z' }]
    },
    {
      id: 'inherited-only', lastConversationDate: '2026-11-09',
      lastInteractionTime: '2026-11-09T23:00:00.000Z',
      messages: [
        { role: 'system', text: '[继续自上一个窗口]', _isHandoffNote: true, createdAt: '2026-11-09T23:00:00.000Z' },
        { role: 'user', text: 'copied', _inheritedFromWindow: 'real', createdAt: '2026-11-09T23:01:00.000Z' }
      ]
    }
  ];
  const module = loadChatModule(makeStore(chats, 'missing-active-chat'));

  assert.equal(module.selectWindowInheritanceSource({ chats }, 'new-target').id, 'real');
});

test('explicit pending handoff remains the source ahead of normal inheritance', async () => {
  const chats = [makeProjectChats()[0]];
  const store = makeStore(chats, 'missing-active-chat');
  store._pendingHandoff = {
    package: { window_id: 'current', project_id: 'p1', last_updated: '2026-11-08T12:00:00.000Z' },
    recentMessages: [{ role: 'user', text: 'explicit handoff', createdAt: '2026-11-08T12:00:00.000Z' }]
  };
  const module = loadChatModule(store, { dom: { chatInput: makeElement({ value: '/help' }) } });

  await module.sendMessage();

  const created = store.projects[0].chats[store.projects[0].chats.length - 1];
  assert.equal(created.messages[1]._inheritedFromWindow, 'handoff');
  assert.equal(created.messages[1].text, 'explicit handoff');
  assert.equal(store._pendingHandoff, null);
});
