const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness(messages) {
  let chatModule;
  const chat = { id: 'chat-1', name: 'chat', messages: messages.slice() };
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-1',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', name: 'Codex', chats: [chat] }],
    diaries: [], diaryDeliveries: [], todos: [], books: [], litterThoughts: []
  };
  const chatMessages = { innerHTML: '', scrollTop: 0, scrollHeight: 0, classList: { toggle() {} } };
  const context = {
    AppCore: {
      register(_name, module) { chatModule = module; },
      getStore() { return store; },
      getActiveProject() { return store.projects[0]; },
      getActiveChatObj() { return chat; },
      $(id) { return id === 'chatMessages' ? chatMessages : null; },
      fmtDate() { return { iso: '2026-10-31' }; },
      nowTime() { return '12:00'; },
      generateMsgId() { return 'generated'; },
      escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
      USER_NAME: 'mays'
    },
    getAIName() { return 'Codex'; },
    resolveArtifactRefs(text) { return text; },
    console,
    window: {},
    URL,
    document: { querySelectorAll() { return []; } },
    setTimeout, clearTimeout
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8'), context, {
    filename: path.join(__dirname, '..', 'public', 'js', 'chat.js')
  });
  return { chat, chatMessages, render() { chatModule.renderChatMessages(); return chatMessages.innerHTML; } };
}

test('Codex receipt UI escapes source text, links only an accurate URL, and marks omitted sources', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'd'.repeat(64);
  const html = createHarness([{
    id: 'user-1', role: 'user', text: '查资料', createdAt: '2026-10-31T00:00:00.000Z',
    _codexReceipts: { activities: [{
      requestId, activityId, tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'available',
      sourceCards: [
        { requestId, activityId, sourceId, displayUrl: 'https://example.org/article', redacted: true, title: '<img src=x onerror=alert(1)>', refId: 'ref_1' },
        { requestId, activityId, sourceId: 'ws_' + 'e'.repeat(64), displayUrl: 'javascript:alert(1)', redacted: false, url: 'javascript:alert(1)', title: 'bad' }
      ]
    }], omitted: true, omittedSources: 3 }
  }]).render();

  assert.match(html, /codex-receipt-panel/);
  assert.match(html, /搜索动作已结束/);
  assert.match(html, /部分来源已省略/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="https:\/\/example\.org\/article"/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('Codex receipt UI makes a valid accurate source URL clickable', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'f'.repeat(64);
  const html = createHarness([{
    id: 'user-valid-url', role: 'user', text: '查资料', createdAt: '2026-10-31T00:00:00.000Z',
    _codexReceipts: { activities: [{
      requestId, activityId, tool: 'web_search', phase: 'completed', action: 'open_page', outcome: 'unknown',
      sources: 'available',
      sourceCards: [{ requestId, activityId, sourceId, displayUrl: 'https://example.org/article', url: 'https://example.org/article', redacted: false, title: '准确来源' }]
    }] }
  }]).render();

  assert.match(html, /打开网页动作已结束/);
  assert.match(html, /href="https:\/\/example\.org\/article"/);
});

test('Codex receipt UI does not show an omission notice for a complete small open_page receipt', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'a'.repeat(64);
  const targetUrl = 'https://example.org/guide';
  const html = createHarness([{
    id: 'user-small-open-page', role: 'user', text: '打开资料', createdAt: '2026-10-31T00:00:00.000Z',
    _codexReceipts: { activities: [{
      requestId, activityId, tool: 'web_search', phase: 'completed', action: 'open_page', outcome: 'unknown',
      targetSourceId: sourceId, targetDisplayUrl: targetUrl, targetRedacted: false, targetUrl, sources: 'available', sourceCards: []
    }] }
  }]).render();

  assert.match(html, /打开网页动作已结束/);
  assert.doesNotMatch(html, /部分来源已省略/);
});

test('Codex receipt UI describes compacted non-source details without claiming sources were omitted', () => {
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const html = createHarness([{
    id: 'user-omitted-details', role: 'user', text: '打开资料', createdAt: '2026-10-31T00:00:00.000Z',
    _codexReceipts: { omitted: true, omittedSources: 0, activities: [{
      requestId, activityId, tool: 'web_search', phase: 'completed', action: 'open_page', outcome: 'unknown',
      sources: 'available', sourceCards: []
    }] }
  }]).render();

  assert.match(html, /部分回执详情已省略/);
  assert.doesNotMatch(html, /部分来源已省略/);
});

test('ordinary Codex chat remains renderable without receipts', () => {
  const html = createHarness([{ id: 'user-2', role: 'user', text: '你好', createdAt: '2026-10-31T00:00:00.000Z' }]).render();
  assert.match(html, /你好/);
  assert.doesNotMatch(html, /codex-receipt-panel/);
});
