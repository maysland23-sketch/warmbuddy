const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isAiStatusEventType,
  normalizeAiStatus,
  getStatusEventContent,
  createStatusNotice
} = require('../proactive-status-utils');

test('recognizes canonical and legacy AI status event types only', () => {
  assert.equal(isAiStatusEventType('status'), true);
  assert.equal(isAiStatusEventType('ai_status_change'), true);
  assert.equal(isAiStatusEventType('message'), false);
  assert.equal(isAiStatusEventType(''), false);
});

test('normalizes AI status to the existing trimmed 15-character limit', () => {
  assert.equal(normalizeAiStatus('  等你回家  '), '等你回家');
  assert.equal(normalizeAiStatus('12345678901234567890'), '123456789012345');
  assert.equal(normalizeAiStatus(''), '');
});

test('status event content prefers the marker value over display prose', () => {
  assert.equal(
    getStatusEventContent({ status: '  等你回家  ', message: '我刚刚想到你了' }),
    '等你回家'
  );
  assert.equal(
    getStatusEventContent({ status: '', message: '普通主动消息' }),
    '普通主动消息'
  );
});

test('creates one proactive system notice row for an AI status event', () => {
  assert.deepEqual(
    createStatusNotice({
      projectId: 'p1',
      windowId: 'c1',
      messageId: 'proactive_evt_42_notice',
      eventId: 42,
      driveKey: 'resonance',
      createdAt: '2026-10-04T00:00:00.000Z',
      actionType: 'status',
      aiName: '暖伴'
    }),
    {
      project_id: 'p1',
      window_id: 'c1',
      message_id: 'proactive_evt_42_notice',
      role: 'system',
      content: '戳一戳更新了',
      token_usage: 0,
      created_at: '2026-10-04T00:00:00.000Z',
      metadata: {
        proactive: true,
        action_type: 'status',
        drive_key: 'resonance',
        event_id: 42,
        content_type: 'status_notification'
      }
    }
  );
});
