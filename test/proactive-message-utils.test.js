const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createProactiveChatMessage,
  mergeProactiveMessages
} = require('../proactive-message-utils');

test('creates a proactive chat row with the backend trigger timestamp', () => {
  const row = createProactiveChatMessage({
    projectId: 'p1',
    windowId: 'c1',
    messageId: 'proactive_evt_42',
    role: 'assistant',
    content: '我刚刚想到你了。',
    createdAt: '2026-09-01T03:04:05.000Z',
    actionType: 'message',
    driveKey: 'resonance',
    eventId: 42
  });

  assert.deepEqual(row, {
    project_id: 'p1',
    window_id: 'c1',
    message_id: 'proactive_evt_42',
    role: 'assistant',
    content: '我刚刚想到你了。',
    token_usage: 0,
    created_at: '2026-09-01T03:04:05.000Z',
    metadata: {
      proactive: true,
      action_type: 'message',
      drive_key: 'resonance',
      event_id: 42
    }
  });
});

test('merges cloud messages by stable id without duplicating an existing bubble', () => {
  const merged = mergeProactiveMessages([
    { id: 'proactive_evt_1', role: 'ai', text: '旧内容', createdAt: '2026-09-01T03:01:00.000Z' }
  ], [
    { message_id: 'proactive_evt_1', role: 'assistant', content: '新内容', created_at: '2026-09-01T03:01:00.000Z', metadata: { proactive: true } },
    { message_id: 'proactive_evt_2', role: 'assistant', content: '第二条', created_at: '2026-09-01T03:02:00.000Z', metadata: { proactive: true } }
  ]);

  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'proactive_evt_1');
  assert.equal(merged[0].text, '新内容');
  assert.equal(merged[1].id, 'proactive_evt_2');
});

test('orders restored proactive messages by their original creation time', () => {
  const merged = mergeProactiveMessages([], [
    { message_id: 'proactive_evt_2', role: 'assistant', content: 'later', created_at: '2026-09-01T03:02:00.000Z', metadata: { proactive: true } },
    { message_id: 'proactive_evt_1', role: 'assistant', content: 'earlier', created_at: '2026-09-01T03:01:00.000Z', metadata: { proactive: true } }
  ]);

  assert.deepEqual(merged.map(message => message.id), ['proactive_evt_1', 'proactive_evt_2']);
  assert.equal(merged[0].createdAt, '2026-09-01T03:01:00.000Z');
});
