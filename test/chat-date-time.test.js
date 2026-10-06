const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'public', 'js', 'chat-time.js');

function loadChatTimeModule() {
  let chatTimeModule;
  const context = {
    AppCore: {
      register(_name, module) {
        chatTimeModule = module;
      }
    }
  };
  const source = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : '';
  vm.runInNewContext(source, context, { filename: modulePath });
  return chatTimeModule;
}

function localParts(date) {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  };
}

function loadChatHarness(messages = []) {
  let chatModule;
  const chat = { id: 'c1', name: 'chat', messages: messages.slice() };
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', name: 'project', memories: [], chats: [Object.assign(chat, {
      chatTokens: 0,
      sharedMemoryIds: []
    })] }],
    todos: [],
    books: [],
    diaries: [],
    diaryDeliveries: [],
    litterThoughts: []
  };
  const elements = {};
  const element = (extra = {}) => Object.assign({
    value: '',
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {} }
  }, extra);
  elements.chatInput = element();
  elements.draftBubblesArea = element();
  elements.draftBubblesScroll = element();
  elements.chatSendPlus = element();
  elements.chatSendBtn = element();
  elements.chatTypingArea = element();
  elements.chatMessages = element({ scrollTop: 0, scrollHeight: 0 });
  elements.replyPreviewBar = element();
  elements.projectList = element();

  const context = {
    console,
    AppCore: {
      register(_name, module) {
        if (module && module.sendAllDraftBubbles) chatModule = module;
      },
      getStore() { return store; },
      getActiveProject() { return store.projects[0]; },
      getActiveChatObj() { return chat; },
      getActiveApiConfig() { return { enabled: true, apiKey: '', endpoint: '', model: '' }; },
      getActiveChatAiSettings() { return { autoDateTime: true, autoWeather: true, aiVoice: false, webSearch: false }; },
      getModule() { return null; },
      $(id) { return elements[id] || null; },
      fmtDate() { return { iso: '2026-10-04' }; },
      nowTime() { return '21:00'; },
      generateMsgId() { return `msg-${chat.messages.length + 1}`; },
      escapeHtml(value) { return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
      saveStore() {},
      USER_NAME: 'mays',
      BACKEND_URL: ''
    },
    ChatTimeModule: loadChatTimeModule(),
    UIModule: { toast() {}, closeModal() {}, showModal() {}, navigate() {} },
    SyncModule: { scheduleMessageSync() {}, syncProjectConfigToBackend() {} },
    MemoryModule: { getCML() { return { userStarredMemories: [] }; } },
    resolveArtifactRefs(text) { return text; },
    window: { _pendingFiles: [] },
    document: { querySelectorAll() { return []; } },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8'), context, {
    filename: path.join(__dirname, '..', 'public', 'js', 'chat.js')
  });
  return { chat, elements, chatModule };
}

test('creates a chat message with one canonical timestamp and local display parts', () => {
  const chatTime = loadChatTimeModule();
  assert.equal(typeof chatTime?.createMessage, 'function');

  const createdAt = new Date(2026, 9, 4, 21, 5, 6, 789);
  const message = chatTime.createMessage({ role: 'user', text: 'hello', id: 'm1' }, createdAt);

  assert.equal(message.createdAt, createdAt.toISOString());
  assert.deepEqual({ date: message.date, time: message.time }, localParts(createdAt));
  assert.equal(message.text, 'hello');
});

test('prefers createdAt and parses date plus time for display and sorting', () => {
  const chatTime = loadChatTimeModule();
  assert.equal(typeof chatTime?.getTimeInfo, 'function');

  const createdAt = new Date(2026, 8, 30, 20, 0, 0, 123);
  const fromCreatedAt = chatTime.getTimeInfo({
    createdAt: createdAt.toISOString(),
    date: '1999-01-01',
    time: '00:00'
  });
  assert.deepEqual({ date: fromCreatedAt.date, time: fromCreatedAt.time }, localParts(createdAt));

  const fromParts = chatTime.getTimeInfo({ date: '2026-10-03', time: '20:00' });
  assert.equal(fromParts.date, '2026-10-03');
  assert.equal(fromParts.time, '20:00');
});

test('does not assign a date to a legacy HH:mm message from a fallback date', () => {
  const chatTime = loadChatTimeModule();
  assert.equal(chatTime.getTimeInfo({ time: '21:00' }, '2026-10-04'), null);
  assert.equal(chatTime.getTimeInfo({ time: '21:00' }), null);
});

test('sorts local and cloud messages chronologically without mutating input and keeps ties stable', () => {
  const chatTime = loadChatTimeModule();
  const late = new Date(2026, 9, 4, 21, 0, 0, 0).toISOString();
  const same = new Date(2026, 9, 4, 21, 30, 0, 0).toISOString();
  const messages = [
    { id: 'late', createdAt: late },
    { id: 'early', date: '2026-10-04', time: '20:00' },
    { id: 'tie-a', createdAt: same },
    { id: 'tie-b', createdAt: same }
  ];

  const sorted = chatTime.sortMessages(messages, '2026-10-04');

  assert.deepEqual(sorted.map(message => message.id), ['early', 'late', 'tie-a', 'tie-b']);
  assert.deepEqual(messages.map(message => message.id), ['late', 'early', 'tie-a', 'tie-b']);
});

test('sorts only trusted contiguous runs and keeps legacy/time-divider barriers fixed', () => {
  const chatTime = loadChatTimeModule();
  const messages = [
    { id: 'known-late', date: '2026-10-04', time: '21:00' },
    { id: 'legacy-a', time: '20:00' },
    { id: 'known-second-late', date: '2026-10-04', time: '22:00' },
    { id: 'known-second-early', date: '2026-10-04', time: '21:30' },
    { id: 'divider', contentType: 'dateDivider', date: '2026-10-05', time: '00:00' },
    { id: 'legacy-b', time: '00:05' },
    { id: 'known-next', date: '2026-10-05', time: '01:00' }
  ];

  const sorted = chatTime.sortMessages(messages, '2026-10-06');

  assert.deepEqual(sorted.map(message => message.id), [
    'known-late', 'legacy-a', 'known-second-early', 'known-second-late',
    'divider', 'legacy-b', 'known-next'
  ]);
  assert.deepEqual(messages.map(message => message.id), [
    'known-late', 'legacy-a', 'known-second-late', 'known-second-early',
    'divider', 'legacy-b', 'known-next'
  ]);
  assert.equal(sorted[1].id, 'legacy-a');
  assert.equal(sorted[4].id, 'divider');
  assert.equal(sorted[5].id, 'legacy-b');
});

test('merges new trusted cloud messages without reordering existing history', () => {
  const chatTime = loadChatTimeModule();
  const existing = [
    { id: 'known-late', date: '2026-10-04', time: '21:00' },
    { id: 'legacy', time: '21:30' },
    { id: 'divider', contentType: 'dateDivider', date: '2026-10-05', time: '00:00' },
    { id: 'known-next', date: '2026-10-05', time: '01:00' }
  ];
  const incoming = [
    { id: 'cloud-early', date: '2026-10-04', time: '20:00' },
    { id: 'cloud-tie', date: '2026-10-04', time: '21:00' },
    { id: 'cloud-next', date: '2026-10-05', time: '02:00' }
  ];

  const merged = chatTime.mergeNewMessages(existing, incoming);

  assert.deepEqual(merged.map(message => message.id), [
    'cloud-early', 'known-late', 'cloud-tie', 'legacy', 'divider',
    'known-next', 'cloud-next'
  ]);
  assert.deepEqual(existing.map(message => message.id), [
    'known-late', 'legacy', 'divider', 'known-next'
  ]);
  assert.deepEqual(
    merged.filter(message => existing.some(item => item.id === message.id)).map(message => message.id),
    existing.map(message => message.id)
  );
});

test('batch draft command creates timestamped user, system, and AI messages', async () => {
  const harness = loadChatHarness();
  harness.elements.chatInput.value = '/help';
  harness.chatModule.stageDraftBubble();

  await harness.chatModule.sendAllDraftBubbles();

  assert.equal(harness.chat.messages.length, 3);
  for (const message of harness.chat.messages) {
    assert.match(message.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(message.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(message.time, /^\d{2}:\d{2}$/);
  }
  assert.deepEqual(harness.chat.messages.map(message => message.role), ['user', 'system', 'ai']);
});

test('renders the date on both user and AI bubbles from the canonical message time', () => {
  const harness = loadChatHarness([
    { id: 'u1', role: 'user', text: '用户消息', date: '2026-09-30', time: '20:00' },
    { id: 'a1', role: 'ai', text: 'AI消息', date: '2026-09-30', time: '20:01' }
  ]);

  harness.chatModule.renderChatMessages();

  assert.match(harness.elements.chatMessages.innerHTML, /09-30 20:00/);
  assert.match(harness.elements.chatMessages.innerHTML, /09-30 20:01/);
  assert.equal((harness.elements.chatMessages.innerHTML.match(/chat-date-separator/g) || []).length, 1);
});

test('places the date title before the first system message and ignores legacy date-divider rows', () => {
  const harness = loadChatHarness([
    { id: 'legacy-divider', role: 'system', contentType: 'dateDivider', text: '旧日期分隔线', date: '2026-10-04', time: '19:00' },
    { id: 's1', role: 'system', text: '确认欲', date: '2026-10-04', time: '21:00' },
    { id: 'u1', role: 'user', text: '收到', date: '2026-10-04', time: '21:01' }
  ]);

  harness.chatModule.renderChatMessages();

  const html = harness.elements.chatMessages.innerHTML;
  assert.equal(html.includes('旧日期分隔线'), false);
  assert.ok(html.indexOf('chat-date-separator') < html.indexOf('确认欲'));
  assert.equal((html.match(/chat-gap-separator/g) || []).length, 0);
});

test('uses system prompts when calculating chronological gaps', () => {
  const harness = loadChatHarness([
    { id: 's1', role: 'system', text: '猫砂盆好像需要铲一铲', date: '2026-10-04', time: '20:00' },
    { id: 's2', role: 'system', text: '确认欲', date: '2026-10-04', time: '21:00' },
    { id: 'u1', role: 'user', text: '好的', date: '2026-10-04', time: '21:01' }
  ]);

  harness.chatModule.renderChatMessages();

  assert.equal((harness.elements.chatMessages.innerHTML.match(/chat-gap-separator/g) || []).length, 1);
  assert.ok(harness.elements.chatMessages.innerHTML.indexOf('猫砂盆好像需要铲一铲') < harness.elements.chatMessages.innerHTML.indexOf('确认欲'));
});
