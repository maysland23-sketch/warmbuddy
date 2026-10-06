const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadCodex(options = {}) {
  const source = fs.readFileSync('public/js/codex.js', 'utf8');
  let module;
  const dom = options.dom || {};
  const sandbox = {
    console,
    Promise,
    Date,
    URL,
    TextEncoder,
    TextDecoder,
    ReadableStream,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: options.fetchImpl,
    localforage: options.storage || {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {}
    },
    AppCore: {
      BACKEND_URL: 'http://app.test',
      register: (_name, value) => { module = value; },
      getStore: () => options.store || { projects: [] },
      saveStore: () => {},
      getModule: options.getModule || (() => null),
      $: id => dom[id] || null
    },
    ChatModule: options.chatModule,
    UIModule: { toast: () => {} }
  };
  vm.runInNewContext(source, sandbox, { filename: 'public/js/codex.js' });
  return module;
}

function responseFromChunks(chunks, headers = { 'content-type': 'text/event-stream' }) {
  const encoded = chunks.map(chunk => chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(chunk));
  let index = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: name => headers[name.toLowerCase()] || null },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= encoded.length) return { done: true, value: undefined };
            return { done: false, value: encoded[index++] };
          },
          async cancel() {},
          releaseLock() {}
        };
      }
    }
  };
}

function splitIntoChunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

test('Codex frontend builds the exact bounded request body and rejects extra fields', () => {
  const codex = loadCodex();
  const sessionId = 'gs_' + 'a'.repeat(64);
  assert.deepEqual(JSON.parse(codex.createRequestBody('你好', sessionId)), {
    prompt: '你好', sessionId
  });
  assert.throws(() => codex.createRequestBody('  '), /CODEX_INVALID_PROMPT/);
  assert.throws(() => codex.createRequestBody('x\0y'), /CODEX_INVALID_PROMPT/);
  assert.throws(() => codex.createRequestBody('x', 'private-thread'), /CODEX_INVALID_SESSION/);
  assert.throws(() => codex.createRequestBody('x', sessionId, { token: 'secret' }), /CODEX_INVALID_REQUEST/);
});

test('Codex frontend parses fragmented named SSE, heartbeats, Unicode, and redacts payload fields', async () => {
  const codex = loadCodex();
  const sid = 'gs_' + 'b'.repeat(64);
  const stream = [
    ': heartbeat\n\n',
    'event: session\ndata: {"sessionId":"' + sid + '","threadId":"private"}\n\n',
    'event: status\ndata: {"status":"running","stderr":"hidden"}\n\n',
    'event: message\ndata: {"text":"完整的😀消息","stderr":"hidden"}\n\n',
    'event: error\ndata: {"code":"BUSY","stderr":"hidden"}\n\n',
    'event: completion\ndata: {"status":"failed","threadId":"private"}\n\n'
  ];
  const events = [];
  await assert.rejects(
    () => codex.consumeSse(responseFromChunks(splitIntoChunks(stream.join(''), 3)), {
      onEvent: event => events.push(event)
    }),
    error => error.code === 'BUSY'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { type: 'session', payload: { sessionId: sid } },
    { type: 'status', payload: { status: 'running' } },
    { type: 'message', payload: { text: '完整的😀消息' } },
    { type: 'error', payload: { code: 'BUSY' } }
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private|hidden/);
});

test('Codex frontend requires a complete completion event and never dispatches an incomplete EOF event', async () => {
  const codex = loadCodex();
  const events = [];
  await assert.rejects(
    () => codex.consumeSse(responseFromChunks(['event: completion\ndata: {"status":"completed"}\n']), {
      onEvent: event => events.push(event)
    }),
    error => error.code === 'CODEX_GATEWAY_INCOMPLETE'
  );
  assert.deepEqual(events, []);
});

test('Codex frontend stream injects no browser credentials, uses same-origin route, and commits only after completion', async () => {
  const sid = 'gs_' + 'c'.repeat(64);
  const requests = [];
  const codex = loadCodex({
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responseFromChunks([
        'event: session\ndata: {"sessionId":"' + sid + '"}\n\n',
        'event: message\ndata: {"text":"reply"}\n\n',
        'event: completion\ndata: {"status":"completed"}\n\n'
      ]);
    }
  });
  const events = [];
  const result = await codex.stream({ prompt: 'hello', onEvent: event => events.push(event) });
  assert.equal(result.completed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://app.test/api/codex/stream');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { prompt: 'hello' });
  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.deepEqual(events.map(event => event.type), ['session', 'message', 'completion']);
});

test('Codex session lifecycle keeps the original continuation session on failure and does not replay', async () => {
  const oldSession = 'gs_' + 'd'.repeat(64);
  const newSession = 'gs_' + 'e'.repeat(64);
  const values = new Map();
  const storage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); }
  };
  const requests = [];
  const codex = loadCodex({
    storage,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      if (requests.length === 1) {
        return responseFromChunks([
          'event: session\ndata: {"sessionId":"' + newSession + '"}\n\n',
          'event: completion\ndata: {"status":"completed"}\n\n'
        ]);
      }
      return responseFromChunks([
        'event: error\ndata: {"code":"UNKNOWN_SESSION","detail":"private"}\n\n'
      ]);
    }
  });
  const key = codex.sessionKey('codex-gateway', 'codex-code-test', 'chat-1');
  await codex.runTurn({ projectId: 'codex-code-test', chatId: 'chat-1', prompt: 'first' });
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(key))), { sessionId: newSession });
  await assert.rejects(() => codex.runTurn({ projectId: 'codex-code-test', chatId: 'chat-1', prompt: 'second' }), error => error.code === 'UNKNOWN_SESSION');
  assert.deepEqual(requests, [{ prompt: 'first' }, { prompt: 'second', sessionId: newSession }]);
  assert.deepEqual(JSON.parse(JSON.stringify(await storage.getItem(key))), { sessionId: newSession });
  assert.notEqual(oldSession, newSession);
});

test('Codex cancellation while reading an already-open SSE body is canceled, not failed', async () => {
  let requestSignal;
  let releaseRead;
  const states = [];
  const codex = loadCodex({
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
        body: {
          getReader() {
            return {
              read() {
                return new Promise((resolve, reject) => {
                  releaseRead = () => reject(Object.assign(new Error('aborted while reading'), { name: 'AbortError' }));
                  requestSignal.addEventListener('abort', releaseRead, { once: true });
                });
              },
              async cancel() {},
              releaseLock() {}
            };
          }
        }
      };
    }
  });
  const caller = new AbortController();
  const pending = codex.runTurn({
    projectId: 'codex-code-test', chatId: 'chat-read-abort', prompt: 'wait',
    signal: caller.signal, onState: state => states.push(state)
  });
  while (!releaseRead) await new Promise(resolve => setTimeout(resolve, 0));
  caller.abort();
  await assert.rejects(() => pending, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.deepEqual(states, ['canceled']);
});

test('an older Codex turn cannot hide the stop button for a newer active chat', async () => {
  const stop = { style: {} };
  const controls = { style: {} };
  const send = { disabled: false };
  const typing = { innerHTML: '' };
  const store = {
    activeProject: 'codex-code-test',
    activeChat: 'chat-a',
    projects: [{
      id: 'codex-code-test', runtime: 'codex-gateway', chats: [
        { id: 'chat-a', messages: [] }, { id: 'chat-b', messages: [] }
      ]
    }]
  };
  const openedReads = [];
  const codex = loadCodex({
    store,
    dom: { codexStopBtn: stop, codexControls: controls, chatSendBtn: send, chatTypingArea: typing },
    chatModule: {
      buildCodexPromptContext: () => ({ prompt: 'prompt' }),
      commitCodexResponse: async () => {}
    },
    fetchImpl: async (_url, init) => ({
      ok: true,
      status: 200,
      headers: { get: name => name.toLowerCase() === 'content-type' ? 'text/event-stream' : null },
      body: {
        getReader() {
          return {
            read() {
              return new Promise((_resolve, reject) => {
                const abort = () => reject(Object.assign(new Error('read aborted'), { name: 'AbortError' }));
                openedReads.push({ signal: init.signal, abort });
                init.signal.addEventListener('abort', abort, { once: true });
              });
            },
            async cancel() {},
            releaseLock() {}
          };
        }
      }
    })
  });
  const abortA = new AbortController();
  const abortB = new AbortController();
  const turnA = codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'chat-a', userText: 'a', signal: abortA.signal });
  while (openedReads.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
  store.activeChat = 'chat-b';
  const turnB = codex.sendChatTurn({ projectId: 'codex-code-test', chatId: 'chat-b', userText: 'b', signal: abortB.signal });
  while (openedReads.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stop.style.display, '');
  abortA.abort();
  await assert.rejects(() => turnA, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(stop.style.display, '');
  abortB.abort();
  await assert.rejects(() => turnB, error => error.code === 'CODEX_GATEWAY_ABORTED');
  assert.equal(stop.style.display, 'none');
});
