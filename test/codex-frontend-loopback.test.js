const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');

function loadCodex(baseUrl, store, storage, state) {
  const source = fs.readFileSync('public/js/codex.js', 'utf8');
  let module;
  const chat = {
    buildCodexPromptContext: options => ({
      prompt: options.continuation ? 'continuation external context' : 'initial WarmBuddy context',
      customPromptContext: ''
    }),
    commitCodexResponse: async options => { state.commits.push(options); },
    renderChatMessages() {}
  };
  const sandbox = {
    console,
    Promise,
    Date,
    Math,
    URL,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    fetch,
    setTimeout,
    clearTimeout,
    localforage: storage,
    ChatModule: chat,
    AppCore: {
      BACKEND_URL: baseUrl,
      getStore: () => store,
      getModule: name => name === 'chat' ? chat : name === 'sync' ? { scheduleCodexMessageSync() {} } : null,
      saveStore() {},
      gid: prefix => prefix + 'generated',
      $: () => null,
      escapeHtml: value => String(value),
      register: (_name, value) => { module = value; }
    },
    UIModule: { toast() {} }
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/codex.js' });
  return module;
}

test('Codex frontend loopback reads chunked SSE, performs one same-session search integration, and deletes locally', async () => {
  const sessionId = 'gs_' + 'f'.repeat(64);
  const state = { posts: [], searches: [], deletes: [], commits: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/api/codex/config' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ webMode: 'legacy' }));
      }
      if (req.url === '/api/codex/stream' && req.method === 'POST') {
        const parsed = JSON.parse(body);
        state.posts.push(parsed);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
        const events = parsed.sessionId
          ? [
              'event: message\ndata: {"text":"整合完成😀"}\n\n',
              'event: completion\ndata: {"status":"completed"}\n\n'
            ]
          : [
              'event: session\ndata: {"sessionId":"' + sessionId + '"}\n\n',
              ': heartbeat\n\n',
              'event: status\ndata: {"status":"running"}\n\n',
              'event: message\ndata: {"text":"需要搜索 [[SEARCH:天气]]"}\n\n',
              'event: completion\ndata: {"status":"completed"}\n\n'
            ];
        let index = 0;
        const writeNext = () => {
          if (index >= events.length) return res.end();
          const text = events[index++];
          res.write(text.slice(0, Math.max(1, Math.floor(text.length / 2))));
          setTimeout(() => {
            res.write(text.slice(Math.max(1, Math.floor(text.length / 2))));
            setTimeout(writeNext, 2);
          }, 2);
        };
        writeNext();
        return;
      }
      if (req.url === '/api/search' && req.method === 'POST') {
        state.searches.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ results: '外部资料：天气晴朗。' }));
      }
      if (req.url === '/api/codex/sessions/' + encodeURIComponent(sessionId) && req.method === 'DELETE') {
        state.deletes.push(req.url);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ status: 'deleted' }));
      }
      res.writeHead(404); res.end();
    });
  });

  const serverAddress = await new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
  const storageValues = new Map();
  const storage = {
    getItem: async key => storageValues.get(key) ?? null,
    setItem: async (key, value) => { storageValues.set(key, value); },
    removeItem: async key => { storageValues.delete(key); }
  };
  const store = {
    activeProject: 'codex-code-test', activeChat: 'chat-1',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'chat-1', aiSettings: { webSearch: true }, messages: [
      { id: 'user-1', role: 'user', text: '查天气', createdAt: new Date().toISOString() }
    ] }] }]
  };
  try {
    const codex = loadCodex(`http://127.0.0.1:${serverAddress.port}`, store, storage, state);
    const result = await codex.sendChatTurn({
      projectId: 'codex-code-test', chatId: 'chat-1', userMessageIds: ['user-1'], userText: '查天气'
    });
    assert.equal(result.completed, true);
    assert.deepEqual(state.posts.map(item => item.sessionId), [undefined, sessionId]);
    assert.deepEqual(state.searches, [{ query: '天气' }]);
    assert.equal(store.projects[0].chats[0].messages.filter(message => message.role === 'ai').length, 2);
    assert.equal(state.commits.length, 1);
    const activeSession = await codex.getSession('codex-code-test', 'chat-1');
    await codex.disconnect({ projectId: 'codex-code-test', chatId: 'chat-1', sessionId: activeSession });
    assert.equal(state.deletes.length, 1);
    assert.equal(await storage.getItem(codex.sessionKey('codex-gateway', 'codex-code-test', 'chat-1')), null);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Codex frontend loopback native mode accepts activity/source without legacy search', async () => {
  const sessionId = 'gs_' + '1'.repeat(64);
  const requestId = 'wr_123e4567-e89b-12d3-a456-426614174000';
  const activityId = 'wa_1';
  const sourceId = 'ws_' + 'a'.repeat(64);
  const state = { posts: [], searches: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/api/codex/config' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ webMode: 'native' }));
      }
      if (req.url === '/api/codex/stream' && req.method === 'POST') {
        state.posts.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'close' });
        const events = [
          'event: session\ndata: {"sessionId":"' + sessionId + '"}\n\n',
          'event: activity\ndata: ' + JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'started', action: 'unknown', outcome: 'unknown' }) + '\n\n',
          'event: activity\ndata: ' + JSON.stringify({ requestId, activityId, tool: 'web_search', phase: 'completed', action: 'search', outcome: 'unknown', sources: 'available' }) + '\n\n',
          'event: source\ndata: ' + JSON.stringify({ requestId, activityId, sourceId, displayUrl: 'https://example.org/native', url: 'https://example.org/native', redacted: false, title: 'Native' }) + '\n\n',
          'event: completion\ndata: {"status":"completed"}\n\n'
        ];
        events.forEach(item => res.write(item));
        return res.end();
      }
      if (req.url === '/api/search') {
        state.searches.push(body);
        res.writeHead(500); return res.end();
      }
      res.writeHead(404); res.end();
    });
  });
  const address = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address())));
  const storage = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
  const store = {
    activeProject: 'codex-code-test', activeChat: 'native-chat',
    projects: [{ id: 'codex-code-test', runtime: 'codex-gateway', chats: [{ id: 'native-chat', aiSettings: { webSearch: true }, messages: [{ id: 'user-native', role: 'user', text: '查资料' }] }] }]
  };
  const stateWithCommits = Object.assign(state, { commits: [] });
  try {
    const codex = loadCodex('http://127.0.0.1:' + address.port, store, storage, stateWithCommits);
    const result = await codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'native-chat', userMessageIds: ['user-native'], userText: '查资料' });
    assert.equal(result.completed, true);
    assert.equal(state.posts.length, 1);
    assert.equal(state.searches.length, 0);
    assert.equal(store.projects[0].chats[0].messages[0]._codexReceipts.activities[0].sourceCards[0].sourceId, sourceId);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
