const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const chatSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');

function createHarness({ diary, messages = [], delivery = true } = {}) {
  let chatModule;
  const chat = { id: 'c1', name: 'chat', messages: messages.slice() };
  const store = {
    activeProject: 'p1',
    activeChat: 'c1',
    projects: [{ id: 'p1', name: 'project', aiName: 'Luna', chats: [chat] }],
    diaries: diary ? [diary] : [],
    diaryDeliveries: diary && delivery ? [{
      id: 'delivery-1', diaryId: diary.id, targetChatId: 'c1', status: 'pending',
      createdAt: '2026-10-04T12:00:00.000Z'
    }] : []
  };
  const chatMessages = {
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    classList: { toggle() {} }
  };
  const context = {
    AppCore: {
      register(name, module) { chatModule = module; },
      getStore() { return store; },
      getActiveProject() { return store.projects[0]; },
      getActiveChatObj() { return chat; },
      $(id) { return id === 'chatMessages' ? chatMessages : null; },
      fmtDate() { return { iso: '2026-10-04' }; },
      nowTime() { return '12:00'; },
      generateMsgId() { return 'generated-message'; },
      escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      },
      USER_NAME: 'mays'
    },
    getAIName() { return 'Luna'; },
    resolveArtifactRefs(text) { return text; },
    console,
    window: {},
    document: { querySelectorAll() { return []; } },
    setTimeout,
    clearTimeout
  };

  vm.runInNewContext(chatSource, context, { filename: 'public/js/chat.js' });

  return {
    chat,
    chatMessages,
    render() {
      chatModule.renderChatMessages();
      return chatMessages.innerHTML;
    }
  };
}

function diary(author) {
  return {
    id: 'd1', author, title: 'Diary', date: '2026-10-04', time: '12:00', content: 'hello'
  };
}

test('new AI diary delivery becomes an AI-side chat card', () => {
  const harness = createHarness({ diary: diary('ai') });

  const html = harness.render();

  assert.equal(harness.chat.messages[0].role, 'ai');
  assert.match(html, /class="chat-row ai"/);
  assert.match(html, /class="chat-bubble ai shared-diary-bubble"/);
});

test('new user diary delivery remains a user-side chat card', () => {
  const harness = createHarness({ diary: diary('user') });

  const html = harness.render();

  assert.equal(harness.chat.messages[0].role, 'user');
  assert.match(html, /class="chat-row user"/);
  assert.match(html, /class="chat-bubble user shared-diary-bubble"/);
});

test('persisted AI diary card renders on the AI side even with a stale message role', () => {
  const harness = createHarness({
    diary: diary('ai'),
    delivery: false,
    messages: [{
      id: 'legacy-card',
      role: 'user',
      text: '',
      contentType: 'shared_diary',
      sharedDiary: diary('ai')
    }]
  });

  const html = harness.render();

  assert.match(html, /class="chat-row ai"/);
  assert.match(html, /class="chat-bubble ai shared-diary-bubble"/);
});

test('missing or unknown diary author falls back to the user side', () => {
  for (const author of [undefined, 'unknown']) {
    const harness = createHarness({ diary: diary(author) });

    const html = harness.render();

    assert.equal(harness.chat.messages[0].role, 'user');
    assert.match(html, /class="chat-row user"/);
    assert.match(html, /class="chat-bubble user shared-diary-bubble"/);
  }
});
