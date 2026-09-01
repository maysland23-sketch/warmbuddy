const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadSyncModule(store, responses, requestedUrls) {
  const source = fs.readFileSync('public/js/sync.js', 'utf8');
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
      saveStore: () => {}
    }
  };
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
