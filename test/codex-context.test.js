const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadChat(store, options = {}) {
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
    queueRoundCompression: options.queueRoundCompression,
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
      getModule: options.getModule || (name => name === 'customPrompts' ? { beginAiRound: () => ({ content: '本轮自定义提示' }) } : null),
      fmtDate: () => ({ iso: '2026-10-05', md: 'Oct 05' }),
      nowTime: () => '12:00',
      daysBetween: () => 1,
      generateMsgId: () => 'generated',
      gid: prefix => prefix + 'generated',
      saveStore() {},
      $: id => (options.dom && options.dom[id]) || null,
      register: (_name, value) => { module = value; }
    },
    handleEmailSend: options.handleEmailSend,
    UIModule: { toast: options.toast || (() => {}), closeModal: options.closeModal || (() => {}) }
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

test('Codex first context sends only L1 without queueing compression or including running assistants', () => {
  const messages = [];
  for (let i = 1; i <= 12; i++) {
    messages.push({ id: 'u-' + i, role: 'user', text: '用户第' + i });
    messages.push({ id: 'a-' + i, role: 'ai', text: '助手第' + i });
  }
  messages.push({ id: 'running', role: 'ai', text: '正在运行', _codexTurnStatus: 'running' });
  const store = {
    activeProject: 'codex-code-test', activeChat: 'codex-chat', todos: [], diaries: [],
    litterThoughts: [], books: [], weather: null,
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', preference: '', memories: [],
      chats: [{ id: 'codex-chat', aiSettings: { autoDateTime: false, autoWeather: false, webSearch: false }, messages }] }]
  };
  let compressionCalls = 0;
  const module = loadChat(store, { queueRoundCompression: () => { compressionCalls++; } });
  const result = module.buildCodexPromptContext({
    projectId: 'codex-code-test', chatId: 'codex-chat', currentMessageIds: ['u-12'],
    currentMessages: [{ id: 'u-12', role: 'user', text: '当前消息' }]
  });

  assert.equal(compressionCalls, 0);
  assert.doesNotMatch(result.prompt, /用户第1(?:\\r?\\n|$)|助手第1(?:\\r?\\n|$)/);
  assert.match(result.prompt, /用户第11/);
  assert.doesNotMatch(result.prompt, /正在运行/);
  assert.equal((result.prompt.match(/当前消息/g) || []).length, 1);
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

test('Codex failed assistant messages cannot commit WarmBuddy actions', async () => {
  const store = makeStore();
  const project = store.projects[1];
  const chat = project.chats[0];
  const module = loadChat(store);
  const failed = { id: 'failed-1', role: 'ai', text: '未完成 [[TODO:不应创建|2099-01-01T09:00+08:00]]',
    _codexRuntime: 'codex-gateway', _codexTurnId: 'turn-failed', _codexTurnStatus: 'failed' };
  chat.messages.push(failed);
  chat._codexGeneration = 1;
  assert.equal(await module.commitCodexResponse({ projectId: project.id, chatId: chat.id,
    turnId: 'turn-failed', generation: 1, assistantMessages: [failed] }), false);
  assert.equal(store.todos.length, 0);
  assert.match(failed.text, /不应创建/);
});

test('Codex new-session context forces current dynamic snapshot and commits it only after acceptance', async () => {
  const store = makeStore();
  const chat = store.projects[1].chats[0];
  chat._dynCtxSnapshot = { reading: '', diary: '旧快照', userState: '', status: '' };
  store.diaries = [{ author: 'user', content: '当前日记', date: '2026-10-06', time: '10:00' }];
  const module = loadChat(store);
  const context = module.buildCodexPromptContext({
    projectId: 'codex-code-test', chatId: 'codex-chat', newSession: true,
    currentUserText: '新会话问题'
  });
  assert.match(context.prompt, /当前日记/);
  assert.equal(chat._dynCtxSnapshot.diary, '旧快照');
  assert.equal(typeof context.commitDynamicContextSnapshot, 'function');
  context.commitDynamicContextSnapshot();
  assert.match(chat._dynCtxSnapshot.diary, /当前日记/);
});

test('Codex marker cleanup advances content version after terminal upload state', async () => {
  const store = makeStore();
  const project = store.projects[1];
  const chat = project.chats[0];
  const module = loadChat(store);
  const message = {
    id: 'terminal-cleanup', role: 'ai',
    text: '完成 [[STATUS:专注中]]', _codexRuntime: 'codex-gateway',
    _codexTurnId: 'turn-cleanup', _codexTurnStatus: 'completed',
    _codexVersion: 7, _codexUpdatedAt: '2026-10-05T00:00:00.000Z',
    _codexWriterId: 'writer-a'
  };
  chat.messages.push(message);
  chat._codexGeneration = 1;
  await module.commitCodexResponse({
    projectId: project.id, chatId: chat.id, turnId: 'turn-cleanup', generation: 1,
    assistantMessages: [message]
  });
  assert.equal(message.text, '完成');
  assert.equal(message._codexVersion, 8);
  assert.notEqual(message._codexUpdatedAt, '2026-10-05T00:00:00.000Z');
  assert.equal(message._syncDirty, true);
});

test('Codex email and TODO actions use original context and preserve failed email semantics', async () => {
  const store = makeStore();
  const project = store.projects[1];
  const chat = project.chats[0];
  const calls = [];
  const syncCalls = [];
  const module = loadChat(store, {
    handleEmailSend: async (...args) => { calls.push(args); return false; },
    getModule: name => {
      if (name === 'customPrompts') return { beginAiRound: () => ({ content: '本轮自定义提示' }) };
      if (name === 'sync') return { syncTodosToBackend: projectId => syncCalls.push(projectId) };
      return null;
    }
  });
  const message = {
    id: 'action-context', role: 'ai',
    text: '结果 [[TODO:原项目待办|2099-01-01T09:00+08:00]] [[EMAIL:主题|正文]]',
    _codexRuntime: 'codex-gateway', _codexTurnId: 'turn-actions', _codexTurnStatus: 'completed'
  };
  chat.messages.push(message);
  chat._codexGeneration = 1;
  store.activeProject = 'claude-code-test';
  const result = await module.commitCodexResponse({
    projectId: project.id, chatId: chat.id, turnId: 'turn-actions', generation: 1,
    assistantMessages: [message]
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], chat);
  assert.equal(calls[0][3].runtime, 'codex-gateway');
  assert.equal(calls[0][3].projectId, project.id);
  assert.equal(calls[0][3].chatId, chat.id);
  assert.equal(calls[0][3].turnId, 'turn-actions');
  assert.equal(calls[0][3].generation, 1);
  assert.equal(typeof calls[0][3].isCurrent, 'function');
  assert.deepEqual(syncCalls, [project.id]);
  assert.equal(chat._codexActionResults['email:action-context:[[EMAIL:主题|正文]]'], 'failed');
  assert.equal(message._codexActionCommitted, true);
});

test('deleting a Codex chat preserves its pending remote mapping after the chat is gone', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-delete', todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway', name: 'Codex Local',
      chats: [
        { id: 'chat-delete', name: 'remove me', sharedMemoryIds: [], chatTokens: 0, messages: [] },
        { id: 'chat-keep', name: 'keep me', sharedMemoryIds: [], chatTokens: 0, messages: [] }
      ]
    }]
  };
  const preserved = [];
  const invalidated = [];
  const codex = {
    preservePendingDisconnect: async (projectId, chatId) => { preserved.push([projectId, chatId]); },
    cancelActive: () => {},
    invalidateChat: (projectId, chatId) => { invalidated.push([projectId, chatId]); },
    updateUi: () => {}
  };
  const module = loadChat(store, {
    dom: {
      delChatCid: { value: 'chat-delete' },
      projectList: { innerHTML: '' },
      currentProjectLabel: { textContent: '' },
      chatMessages: { innerHTML: '', querySelectorAll: () => [] }
    },
    getModule: name => {
      if (name === 'codex') return codex;
      if (name === 'customPrompts') return { beginAiRound: () => ({ content: '' }) };
      return null;
    }
  });
  await module.execDeleteChat();
  assert.deepEqual(preserved, [['codex-code-test', 'chat-delete']]);
  assert.deepEqual(invalidated, [['codex-code-test', 'chat-delete']]);
  assert.deepEqual(store.projects[0].chats.map(chat => chat.id), ['chat-keep']);
});

test('deleting a Codex chat invalidates before pending preservation and blocks stale actions', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-delete', todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway', name: 'Codex Local',
      chats: [{ id: 'chat-delete', name: 'remove me', _codexGeneration: 1, sharedMemoryIds: [], chatTokens: 0, messages: [] },
        { id: 'chat-keep', name: 'keep me', sharedMemoryIds: [], chatTokens: 0, messages: [] }]
    }]
  };
  const preserved = [];
  const canceled = [];
  const invalidated = [];
  let releasePreserve;
  const preserveWait = new Promise(resolve => { releasePreserve = resolve; });
  const deletingChat = store.projects[0].chats[0];
  const codex = {
    cancelActive: (projectId, chatId) => canceled.push([projectId, chatId]),
    invalidateChat: (projectId, chatId, options) => {
      invalidated.push([projectId, chatId, options]);
      deletingChat._codexGeneration += 1;
    },
    preservePendingDisconnect: async (projectId, chatId) => {
      await preserveWait;
      preserved.push([projectId, chatId]);
    },
    clearSessionMapping: () => {},
    updateUi: () => {}
  };
  const module = loadChat(store, {
    dom: {
      delChatCid: { value: 'chat-delete' },
      projectList: { innerHTML: '' },
      currentProjectLabel: { textContent: '' },
      chatMessages: { innerHTML: '', querySelectorAll: () => [] }
    },
    getModule: name => {
      if (name === 'codex') return codex;
      if (name === 'customPrompts') return { beginAiRound: () => ({ content: '' }) };
      return null;
    }
  });

  const deleting = module.execDeleteChat();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(canceled, [['codex-code-test', 'chat-delete']]);
  assert.deepEqual(JSON.parse(JSON.stringify(invalidated)), [['codex-code-test', 'chat-delete', { clearSession: false }]]);

  const stale = { id: 'stale-action', role: 'ai', text: '旧结果 [[TODO:不应创建|2099-01-01T09:00+08:00]]',
    _codexRuntime: 'codex-gateway', _codexTurnId: 'stale-turn', _codexTurnStatus: 'completed' };
  deletingChat.messages.push(stale);
  assert.equal(await module.commitCodexResponse({ projectId: 'codex-code-test', chatId: 'chat-delete',
    turnId: 'stale-turn', generation: 1, assistantMessages: [stale] }), false);
  assert.equal(store.todos.length, 0);

  releasePreserve();
  await deleting;
  assert.deepEqual(preserved, [['codex-code-test', 'chat-delete']]);
  assert.deepEqual(store.projects[0].chats.map(chat => chat.id), ['chat-keep']);
});

test('deleting a Codex project invalidates all project chats before awaiting preservation', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'project-chat-a', todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', name: 'Codex Local', chats: [
      { id: 'project-chat-a', messages: [] }, { id: 'project-chat-b', messages: [] }
    ] }]
  };
  const preserved = [];
  const canceled = [];
  const invalidated = [];
  let releasePreserve;
  const preserveWait = new Promise(resolve => { releasePreserve = resolve; });
  const codex = {
    cancelActive: (projectId, chatId) => canceled.push([projectId, chatId]),
    invalidateProject: projectId => invalidated.push(projectId),
    preservePendingDisconnect: async (projectId, chatId) => {
      await preserveWait;
      preserved.push([projectId, chatId]);
    },
    updateUi: () => {}
  };
  const module = loadChat(store, {
    dom: {
      delProjPid: { value: 'codex-code-test' },
      projectList: { innerHTML: '' },
      currentProjectLabel: { textContent: '' },
      chatMessages: { innerHTML: '', querySelectorAll: () => [] }
    },
    getModule: name => name === 'codex' ? codex : null
  });
  const deleting = module.execDeleteProject();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(canceled, [['codex-code-test', 'project-chat-a'], ['codex-code-test', 'project-chat-b']]);
  assert.deepEqual(invalidated, ['codex-code-test']);
  releasePreserve();
  await deleting;
  assert.deepEqual(preserved, [['codex-code-test', 'project-chat-a'], ['codex-code-test', 'project-chat-b']]);
  assert.equal(store.projects.length, 0);
});

test('failed Codex pending preservation does not silently delete the chat', async () => {
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-preserve-failure', todos: [], books: [], diaries: [], diaryDeliveries: [],
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'chat-preserve-failure', messages: [] }] }]
  };
  let clearCalls = 0;
  const toasts = [];
  const codex = {
    cancelActive: () => {},
    invalidateChat: () => {},
    preservePendingDisconnect: async () => { throw new Error('storage unavailable'); },
    clearSessionMapping: async () => { clearCalls += 1; },
    updateUi: () => {}
  };
  const module = loadChat(store, {
    toast: message => toasts.push(message),
    dom: {
      delChatCid: { value: 'chat-preserve-failure' },
      projectList: { innerHTML: '' },
      currentProjectLabel: { textContent: '' },
      chatMessages: { innerHTML: '', querySelectorAll: () => [] }
    },
    getModule: name => name === 'codex' ? codex : null
  });
  await module.execDeleteChat();
  assert.equal(store.projects[0].chats.length, 1);
  assert.equal(clearCalls, 0);
  assert.equal(toasts.includes('无法保存 Codex 远程映射，聊天未删除。'), true);
});
