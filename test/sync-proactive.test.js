const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSyncModule(store, responses, requestedUrls) {
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
    fetch: url => {
      requestedUrls.push(url);
      const messages = responses.shift() || [];
      return Promise.resolve({ json: () => Promise.resolve({ messages }) });
    },
    renderChatMessages: () => {},
    toLocalDisplayTime: iso => iso,
    MemoryModule: {},
    AppCore: {
      BACKEND_URL: 'https://backend.test',
      getStore: () => store,
      getActiveProject: () => store.projects.find(project => project.id === store.activeProject),
      getActiveChatObj: () => store.projects.flatMap(project => project.chats).find(chat => chat.id === store.activeChat),
      fmtDate: () => ({ iso: '2026-10-04' }),
      saveStore: () => {}
    }
  };
  sandbox.ChatTimeModule = chatTimeModule;
  sandbox.AppCore.register = (name, module) => { sandbox[name + 'Module'] = module; };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/sync.js' });
  return sandbox.SyncModule;
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

test('pullChatMessages orders legacy local system prompts before later prompts from cloud', async () => {
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
    '猫砂盆好像需要铲一铲', '确认欲'
  ]);
});
