const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(store, activeChat) {
  const context = {
    AppCore: {
      getStore() { return store; },
      getActiveChatObj() { return activeChat; },
      gid(prefix) { return prefix + 'generated'; },
      saveStore() {},
      escapeHtml(value) { return String(value || ''); },
      register(name, module) { context.CustomPromptModule = module; }
    },
    UIModule: { toast(message) { context.toasts.push(message); } },
    console,
    Date,
    Math,
    Object,
    Array,
    String,
    Number,
    JSON,
    context: null,
    toasts: []
  };
  context.context = context;
  const sourcePath = path.join(__dirname, '..', 'public', 'js', 'custom-prompts.js');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  context.CustomPromptModule.init();
  return { module: context.CustomPromptModule, context };
}

function makeStore(customPrompts = []) {
  return { customPrompts, projects: [] };
}

test('normalizes persisted definitions, defaults interval, and enforces Unicode body length', () => {
  const longBody = '🙂'.repeat(3001);
  const store = makeStore([
    { id: 'valid', title: 'title', content: '  保留换行\n第二行  ', interval: 0 },
    { id: 'empty', content: '   ' },
    { id: 'long', content: longBody, interval: 'bad' },
    null,
    { id: 'duplicate', content: 'first' },
    { id: 'duplicate', content: 'second' }
  ]);
  const { module } = loadModule(store, { id: 'chat-1', messages: [] });

  const definitions = module.getDefinitions();
  assert.equal(definitions.length, 4);
  assert.equal(definitions[0].interval, 5);
  assert.equal(definitions[0].content, '  保留换行\n第二行  ');
  assert.equal(Array.from(definitions.find((item) => item.id === 'long').content).length, 3000);
  assert.notEqual(definitions[3].id, definitions[4]?.id);
});

test('rejects empty or oversized new definitions while preserving multiline content', () => {
  const store = makeStore();
  const { module } = loadModule(store, { id: 'chat-1', messages: [] });

  assert.equal(module.createDefinition({ content: ' \n ' }), null);
  assert.equal(module.createDefinition({ content: 'a'.repeat(3001) }), null);
  const created = module.createDefinition({ title: '提示', content: '第一行\n第二行', interval: 8 });
  assert.equal(created.interval, 8);
  assert.equal(created.content, '第一行\n第二行');
});

test('injects on the next AI round and then every configured interval', () => {
  const chat = { id: 'chat-1', messages: [] };
  const { module } = loadModule(makeStore(), chat);
  const definition = module.createDefinition({ title: '规则', content: '第一行\n第二行', interval: 3 });

  assert.equal(module.toggleForActiveChat(definition.id, true), true);
  assert.equal(module.beginAiRound(chat).content.includes('第一行\n第二行'), true);
  assert.equal(chat.customPromptRound, 1);
  assert.equal(module.beginAiRound(chat).content, '');
  assert.equal(module.beginAiRound(chat).content, '');
  assert.equal(module.beginAiRound(chat).content.includes('第二行'), true);
  assert.equal(chat.customPromptRound, 4);
  assert.deepEqual(chat.messages, []);
});

test('keeps enablement and counters isolated between chat windows', () => {
  const chatA = { id: 'chat-a', messages: [] };
  const chatB = { id: 'chat-b', messages: [] };
  const store = makeStore();
  const loaded = loadModule(store, chatA);
  const definition = loaded.module.createDefinition({ content: 'only A', interval: 5 });

  assert.equal(loaded.module.toggleForActiveChat(definition.id, true), true);
  assert.match(loaded.module.beginAiRound(chatA).content, /only A/);
  assert.equal(loaded.module.beginAiRound(chatB).content, '');
  assert.equal(chatB.customPromptRound, 1);
  assert.equal(chatA.customPromptRound, 1);
});

test('disabling stops injection and re-enabling resets to the next round', () => {
  const chat = { id: 'chat-1', messages: [] };
  const loaded = loadModule(makeStore(), chat);
  const definition = loaded.module.createDefinition({ content: 'toggle me', interval: 5 });

  loaded.module.toggleForActiveChat(definition.id, true);
  assert.match(loaded.module.beginAiRound(chat).content, /toggle me/);
  assert.equal(loaded.module.toggleForActiveChat(definition.id, false), true);
  assert.equal(loaded.module.beginAiRound(chat).content, '');
  loaded.module.toggleForActiveChat(definition.id, true);
  assert.match(loaded.module.beginAiRound(chat).content, /toggle me/);
});

test('changing interval resets schedule, while editing content preserves it', () => {
  const chat = { id: 'chat-1', messages: [] };
  const loaded = loadModule(makeStore(), chat);
  const definition = loaded.module.createDefinition({ content: 'before', interval: 5 });

  loaded.module.toggleForActiveChat(definition.id, true);
  assert.match(loaded.module.beginAiRound(chat).content, /before/);
  assert.equal(loaded.module.beginAiRound(chat).content, '');
  assert.equal(loaded.module.updateDefinition(definition.id, { interval: 2 }), true);
  assert.match(loaded.module.beginAiRound(chat).content, /before/);
  assert.equal(loaded.module.updateDefinition(definition.id, { content: 'after' }), true);
  assert.equal(loaded.module.beginAiRound(chat).content, '');
  assert.match(loaded.module.beginAiRound(chat).content, /after/);
});

test('blocks enabling when aggregate enabled prompt bodies exceed 6000 code points', () => {
  const chat = { id: 'chat-1', messages: [] };
  const loaded = loadModule(makeStore(), chat);
  const first = loaded.module.createDefinition({ content: '一'.repeat(3000) });
  const second = loaded.module.createDefinition({ content: '二'.repeat(3000) });
  const third = loaded.module.createDefinition({ content: '三' });

  assert.equal(loaded.module.toggleForActiveChat(first.id, true), true);
  assert.equal(loaded.module.toggleForActiveChat(second.id, true), true);
  assert.equal(loaded.module.toggleForActiveChat(third.id, true), false);
  assert.equal(chat.customPromptStates[third.id], undefined);
  assert.equal(loaded.context.toasts.length > 0, true);
});
