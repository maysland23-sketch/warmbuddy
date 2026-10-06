const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadChat(store) {
  const source = fs.readFileSync('public/js/chat.js', 'utf8');
  let module;
  const sandbox = {
    console,
    Promise,
    Date,
    Math,
    URL,
    setTimeout,
    clearTimeout,
    window: {},
    document: { addEventListener() {}, getElementById() { return null; } },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    MemoryModule: {
      getCML: () => ({ aiEmotionalMemories: [], userStarredMemories: [] }),
      getCoreOverview: () => null,
      groupMessagesIntoRounds: messages => {
        const rounds = [];
        let current;
        for (const message of messages) {
          if (message.role === 'user' || !current) { current = { msgs: [] }; rounds.push(current); }
          current.msgs.push(message);
        }
        return rounds;
      }
    },
    ChatTimeModule: { createMessage: fields => fields },
    AppCore: {
      USER_NAME: 'mays',
      BACKEND_URL: '',
      getStore: () => store,
      getProjectById: id => store.projects.find(project => project.id === id) || null,
      getActiveProject: () => store.projects.find(project => project.id === store.activeProject) || null,
      getActiveApiConfig: () => ({ enabled: true }),
      getActiveChatObj: () => null,
      getActiveChatAiSettings: () => ({ autoDateTime: true, autoWeather: false, webSearch: false }),
      getModule: name => name === 'customPrompts' ? { beginAiRound: () => ({ content: '本轮自定义提示' }) } : null,
      fmtDate: () => ({ iso: '2026-10-05', md: 'Oct 05' }),
      nowTime: () => '12:00',
      daysBetween: () => 1,
      generateMsgId: () => 'generated',
      gid: prefix => prefix + 'generated',
      saveStore() {},
      $: () => null,
      register: (_name, value) => { module = value; }
    },
    UIModule: { toast() {} }
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/chat.js' });
  return module;
}

function makeStore() {
  return {
    activeProject: 'claude-code-test', activeChat: 'claude-chat', todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [
      { id: 'claude-code-test', runtime: 'agent-gateway', name: 'Claude', preference: '不要带入', chats: [{ id: 'claude-chat', messages: [] }] },
      { id: 'codex-code-test', runtime: 'codex-gateway', name: 'Codex Local', preference: '只给 Codex 的项目偏好',
        chats: [{ id: 'codex-chat', name: 'main', aiSettings: { autoDateTime: true, autoWeather: false, webSearch: false }, messages: [
          { id: 'old-user', role: 'user', text: '旧用户消息' },
          { id: 'old-ai', role: 'ai', text: '旧助手消息' }
        ] }] }
    ]
  };
}

test('Codex context uses the explicit WarmBuddy project, current rules, L1/L2 history, and one current message', () => {
  const store = makeStore();
  const chat = store.projects[1].chats[0];
  const module = loadChat(store);
  const result = module.buildCodexPromptContext({
    projectId: 'codex-code-test', chatId: 'codex-chat', currentMessageIds: ['current'],
    currentMessages: [{ id: 'current', role: 'user', text: '当前问题 [[FILE:artifact-1]]' }]
  });
  assert.match(result.prompt, /只给 Codex 的项目偏好/);
  assert.doesNotMatch(result.prompt, /不要带入/);
  assert.match(result.prompt, /旧用户消息/);
  assert.match(result.prompt, /旧助手消息/);
  assert.equal((result.prompt.match(/当前问题/g) || []).length, 1);
  assert.match(result.prompt, /附件处理/);
  assert.match(result.prompt, /WARM BUDDY APPLICATION CONTEXT/);
  assert.ok(chat);
});

test('Codex continuation refreshes current preference and dynamic context without replaying full history', () => {
  const store = makeStore();
  const chat = store.projects[1].chats[0];
  const module = loadChat(store);
  store.projects[1].preference = '';
  const result = module.buildCodexPromptContext({
    projectId: 'codex-code-test', chatId: 'codex-chat', continuation: true,
    currentUserText: '新的问题'
  });
  assert.match(result.prompt, /当前无额外项目偏好/);
  assert.match(result.prompt, /Gateway session 已保留历史/);
  assert.doesNotMatch(result.prompt, /旧用户消息|旧助手消息/);
  assert.equal((result.prompt.match(/新的问题/g) || []).length, 1);
  assert.equal(chat.messages.length, 2);
});

test('Codex actions commit only after completion and remain scoped to the original project/chat', async () => {
  const store = makeStore();
  const project = store.projects[1];
  const chat = project.chats[0];
  const module = loadChat(store);
  const assistant = { id: 'assistant-1', role: 'ai', text: '完成 [[TODO:整理资料|2099-01-01T09:00+08:00]] [[STATUS:专注中]]', _codexRuntime: 'codex-gateway', _codexTurnId: 'turn-1', _codexTurnStatus: 'completed' };
  chat.messages.push(assistant);
  chat._codexGeneration = 1;
  await module.commitCodexResponse({ projectId: project.id, chatId: chat.id, turnId: 'turn-1', generation: 1, userMessageIds: [], assistantMessages: [assistant] });
  assert.equal(assistant.text, '完成');
  assert.equal(project._aiStatus, '专注中');
  assert.equal(store.todos[0].projectId, project.id);
  assert.equal(store.todos[0].chatId, chat.id);
  assert.equal(await module.commitCodexResponse({ projectId: project.id, chatId: chat.id, turnId: 'turn-1', generation: 1, assistantMessages: [assistant] }), false);
});
