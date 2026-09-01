const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadChatModule() {
  const sourcePath = path.join(__dirname, '..', 'public', 'js', 'chat.js');
  const context = {
    AppCore: {
      register(name, module) {
        context.ChatModule = module;
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context.ChatModule;
}

const { splitSentences } = loadChatModule();
const split = (text) => Array.from(splitSentences(text));

test('keeps numbered list markers attached to their complete items', () => {
  assert.deepEqual(split('1. 第一项\n2.第二项\n3. 第三项'), [
    '1. 第一项',
    '2.第二项',
    '3. 第三项'
  ]);
});

test('does not split ordinary line breaks into separate bubbles', () => {
  assert.deepEqual(split('第一段自然换行\n第二行仍属于同一段'), [
    '第一段自然换行\n第二行仍属于同一段'
  ]);
});

test('preserves decimal, version, email, and domain dots', () => {
  assert.deepEqual(split('版本 v1.2.3 可以用，今天是 3.14。邮箱 user@example.com 可访问。'), [
    '版本 v1.2.3 可以用，今天是 3.14。',
    '邮箱 user@example.com 可访问。'
  ]);
});

test('does not split URL query punctuation or common abbreviations', () => {
  assert.deepEqual(split('请访问 https://example.com/a?b=1。Mr. Smith 已经到了。'), [
    '请访问 https://example.com/a?b=1。',
    'Mr. Smith 已经到了。'
  ]);
});

test('splits sentence punctuation while keeping closing quotes attached', () => {
  assert.deepEqual(split('他说：“你好。”然后又说！'), [
    '他说：“你好。”',
    '然后又说！'
  ]);
});

test('falls back to the complete trimmed text when there is no safe boundary', () => {
  assert.deepEqual(split('这是一段没有句末标点的完整内容'), [
    '这是一段没有句末标点的完整内容'
  ]);
});
