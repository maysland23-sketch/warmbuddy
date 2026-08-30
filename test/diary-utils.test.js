const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDiaryVisibleToChat,
  createDiaryDelivery,
  buildDiaryInjection
} = require('../diary-utils');

test('public diary is visible to existing target windows only', () => {
  const diary = { visibility_mode: 'public' };
  assert.equal(isDiaryVisibleToChat(diary, 'p2', 'c9', ['c1', 'c2']), false);
  assert.equal(isDiaryVisibleToChat(diary, 'p1', 'c1', ['c1', 'c2']), true);
});

test('selected diary is visible only to selected chat', () => {
  const diary = { visibility_mode: 'selected', visible_chat_ids: ['c1'] };
  assert.equal(isDiaryVisibleToChat(diary, 'p1', 'c1', ['p1']), true);
  assert.equal(isDiaryVisibleToChat(diary, 'p1', 'c2', ['p1']), false);
});

test('each share creates a fresh pending delivery', () => {
  const first = createDiaryDelivery('d1', 'p1', 'c1', 'share');
  const second = createDiaryDelivery('d1', 'p1', 'c1', 'share');
  assert.notEqual(first.id, second.id);
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
});

test('diary injection includes metadata, author signature, and body', () => {
  const injection = buildDiaryInjection({
    title: 'A day', mood: 'calm', date: '2026-08-30', time: '12:34',
    content: 'A full entry', author: 'ai', authorName: 'Luna', sourceWindow: 'evening'
  });
  assert.match(injection, /A day/);
  assert.match(injection, /calm/);
  assert.match(injection, /2026-08-30 12:34/);
  assert.match(injection, /Luna/);
  assert.match(injection, /A full entry/);
});
