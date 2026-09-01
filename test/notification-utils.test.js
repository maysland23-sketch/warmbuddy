const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildNotificationPayload,
  sendNtfyNotification,
  createNotificationDispatcher
} = require('../notification-utils');

test('builds fixed proactive copy from the project AI name without trailing punctuation', () => {
  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'email', content: '敏感邮件正文' }),
    {
      title: '小暖 · 邮件',
      body: '小暖刚刚给你发送了邮件',
      priority: 3
    }
  );

  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'litter', content: '猫砂盆私密内容' }),
    {
      title: '小暖 · 🐾 猫砂盆',
      body: '猫砂盆好像需要铲一铲',
      priority: 3
    }
  );

  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'poke', content: '不应泄露的状态' }),
    {
      title: '小暖 · 戳一戳',
      body: '小暖刚刚戳了戳你',
      priority: 3
    }
  );

  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'status', content: '不应直接展示' }),
    {
      title: '小暖 · 状态更新',
      body: '小暖有了新的状态',
      priority: 3
    }
  );
});

test('uses proactive content for actionable events and maps their priority', () => {
  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'message', driveKey: 'resonance', content: '我刚刚想到你了' }),
    {
      title: '小暖 · 共鸣欲',
      body: '我刚刚想到你了',
      priority: 4
    }
  );

  assert.deepEqual(
    buildNotificationPayload({ aiName: '小暖', actionType: 'todo_wake', content: '该去散步了' }),
    {
      title: '小暖 · 待办提醒',
      body: '该去散步了',
      priority: 5
    }
  );
});

test('preserves punctuation already present in AI-generated notification content', () => {
  const notification = buildNotificationPayload({
    aiName: '小暖',
    actionType: 'message',
    driveKey: 'resonance',
    content: '我刚刚想到你了。'
  });

  assert.equal(notification.body, '我刚刚想到你了。');
});

test('publishes an ntfy JSON message with an event sequence id and click target', async () => {
  const requests = [];
  const response = await sendNtfyNotification({
    baseUrl: 'https://ntfy.sh/',
    topic: 'warmbuddy-test-topic',
    title: '小暖 · 待办提醒',
    body: '该去散步了',
    priority: 5,
    clickUrl: 'https://warmbuddy.onrender.com/?project=p1&chat=c1',
    eventId: 42,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ id: 'ntfy-message-1' }) };
    }
  });

  assert.deepEqual(response, { id: 'ntfy-message-1' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://ntfy.sh/');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/json');
  assert.equal(requests[0].options.headers['X-Sequence-ID'], '42');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    topic: 'warmbuddy-test-topic',
    title: '小暖 · 待办提醒',
    message: '该去散步了',
    priority: 5,
    click: 'https://warmbuddy.onrender.com/?project=p1&chat=c1'
  });
});

test('reports a failed ntfy publish instead of treating non-2xx as delivered', async () => {
  await assert.rejects(
    sendNtfyNotification({
      baseUrl: 'https://ntfy.sh',
      topic: 'warmbuddy-test-topic',
      title: '标题',
      body: '正文',
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'temporarily unavailable' })
    }),
    /ntfy publish failed: 503/
  );
});

test('marks a successful ntfy event without sending a PWA fallback', async () => {
  const published = [];
  const sent = [];
  const failed = [];
  const dispatch = createNotificationDispatcher({
    baseUrl: 'https://ntfy.sh',
    topic: 'warmbuddy-test-topic',
    publish: async options => {
      published.push(options);
      return { id: 'ntfy-message-2' };
    },
    markSent: async (eventId, result) => sent.push({ eventId, result }),
    markFailed: async (eventId, error) => failed.push({ eventId, error })
  });

  const result = await dispatch({
    eventId: 43,
    title: '小暖 · 待办提醒',
    body: '去散步',
    priority: 5,
    clickUrl: 'https://warmbuddy.onrender.com/?project=p1&chat=c1'
  });

  assert.equal(result.sent, true);
  assert.equal(published.length, 1);
  assert.equal(published[0].eventId, 43);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].result, { id: 'ntfy-message-2' });
  assert.equal(failed.length, 0);
});

test('records a failed ntfy event and does not mark it sent', async () => {
  const failed = [];
  const dispatch = createNotificationDispatcher({
    baseUrl: 'https://ntfy.sh',
    topic: 'warmbuddy-test-topic',
    publish: async () => { throw new Error('network down'); },
    markSent: async () => { throw new Error('must not mark sent'); },
    markFailed: async (eventId, error) => failed.push({ eventId, error: error.message })
  });

  const result = await dispatch({ eventId: 44, title: '标题', body: '正文', priority: 3 });

  assert.equal(result.sent, false);
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0], { eventId: 44, error: 'network down' });
});

test('does not attempt ntfy when the topic is not configured', async () => {
  let attempts = 0;
  const dispatch = createNotificationDispatcher({
    baseUrl: 'https://ntfy.sh',
    topic: '',
    publish: async () => { attempts++; }
  });

  const result = await dispatch({ eventId: 45, title: '标题', body: '正文', priority: 3 });

  assert.deepEqual(result, { sent: false, skipped: true, reason: 'not_configured' });
  assert.equal(attempts, 0);
});

test('retries a transient ntfy failure up to the configured attempt limit', async () => {
  let attempts = 0;
  const markedAttempts = [];
  const dispatch = createNotificationDispatcher({
    baseUrl: 'https://ntfy.sh',
    topic: 'warmbuddy-test-topic',
    maxAttempts: 3,
    retryDelayMs: 0,
    publish: async () => {
      attempts++;
      if (attempts < 3) throw new Error('temporary failure');
      return { id: 'ntfy-message-3' };
    },
    markAttempt: async (eventId, attempt) => markedAttempts.push({ eventId, attempt }),
    markSent: async () => {},
    markFailed: async () => { throw new Error('must not mark failed after recovery'); }
  });

  const result = await dispatch({ eventId: 46, title: '标题', body: '正文', priority: 3 });

  assert.equal(result.sent, true);
  assert.equal(attempts, 3);
  assert.deepEqual(markedAttempts, [
    { eventId: 46, attempt: 1 },
    { eventId: 46, attempt: 2 },
    { eventId: 46, attempt: 3 }
  ]);
});

test('keeps an accepted ntfy result successful when status persistence fails', async () => {
  const failed = [];
  const dispatch = createNotificationDispatcher({
    baseUrl: 'https://ntfy.sh',
    topic: 'warmbuddy-test-topic',
    publish: async () => ({ id: 'ntfy-message-4' }),
    markSent: async () => { throw new Error('database unavailable'); },
    markFailed: async (eventId, error) => failed.push({ eventId, error: error.message })
  });

  const result = await dispatch({ eventId: 47, title: '标题', body: '正文', priority: 3 });

  assert.equal(result.sent, true);
  assert.equal(result.result.id, 'ntfy-message-4');
  assert.equal(failed.length, 0);
});
