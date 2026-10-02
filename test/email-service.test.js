const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailService } = require('../email-service');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

function makeService(overrides = {}) {
  const state = {
    enabled: true,
    maxPerDay: 3,
    recipient: 'shared@example.com',
    senderName: 'Shared WarmBuddy',
    sentToday: 0,
    sentDate: '2026-10-02'
  };
  const configuredState = overrides.state || state;
  const requests = [];
  const logs = [];
  const service = createEmailService({
    state: configuredState,
    apiKey: 'test-resend-key',
    now: () => new Date('2026-10-02T10:00:00.000Z'),
    fetchImpl: async (url, init) => {
      requests.push({ url, init, payload: JSON.parse(init.body) });
      return response({ id: 'email-' + requests.length });
    },
    persistState: async () => {},
    logger: {
      log: (...args) => logs.push(['log', ...args]),
      error: (...args) => logs.push(['error', ...args])
    },
    ...overrides
  });
  return { service, state: configuredState, requests, logs };
}

test('manual, desire, and todo sources share emailState recipient, sender, and quota', async () => {
  const { service, state, requests, logs } = makeService();

  const results = await Promise.all([
    service.send({ source: 'manual', requestId: 'manual-1', subject: '手动', body: '一' }),
    service.send({ source: 'desire', requestId: 'desire-1', subject: '欲望', body: '二' }),
    service.send({ source: 'todo', requestId: 'todo-1', subject: '待办', body: '三' })
  ]);

  assert.deepEqual(results.map(result => result.source), ['manual', 'desire', 'todo']);
  assert.equal(state.sentToday, 3);
  assert.deepEqual(requests.map(request => request.payload.to), [
    'shared@example.com', 'shared@example.com', 'shared@example.com'
  ]);
  assert.deepEqual(requests.map(request => request.payload.from), [
    'Shared WarmBuddy <onboarding@resend.dev>',
    'Shared WarmBuddy <onboarding@resend.dev>',
    'Shared WarmBuddy <onboarding@resend.dev>'
  ]);
  const logText = JSON.stringify(logs);
  assert.match(logText, /manual/);
  assert.match(logText, /desire/);
  assert.match(logText, /todo/);
});

test('uses EMAIL_FROM configuration for every shared sender call', async () => {
  const { service, requests } = makeService({
    from: 'WarmBuddy <notifications@mail.example.com>'
  });

  await service.send({
    source: 'manual',
    requestId: 'configured-from',
    subject: '配置发件人',
    body: '正文'
  });

  assert.equal(requests[0].payload.from, 'WarmBuddy <notifications@mail.example.com>');
});

test('missing key, disabled email, missing recipient, and exhausted quota do not call Resend', async t => {
  const cases = [
    ['missing key', { apiKey: '' }, 'resend_api_key_missing'],
    ['disabled email', { state: { enabled: false, maxPerDay: 3, recipient: 'a@example.com', senderName: 'WarmBuddy', sentToday: 0, sentDate: '2026-10-02' } }, 'email_disabled'],
    ['missing recipient', { state: { enabled: true, maxPerDay: 3, recipient: '', senderName: 'WarmBuddy', sentToday: 0, sentDate: '2026-10-02' } }, 'email_recipient_missing'],
    ['exhausted quota', { state: { enabled: true, maxPerDay: 1, recipient: 'a@example.com', senderName: 'WarmBuddy', sentToday: 1, sentDate: '2026-10-02' } }, 'email_daily_limit_reached']
  ];

  for (const [name, overrides, errorName] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const { service } = makeService({
        ...overrides,
        fetchImpl: async () => { calls++; return response({ id: 'must-not-send' }); }
      });

      await assert.rejects(
        service.send({ source: 'manual', requestId: name, subject: 'subject', body: 'body' }),
        error => error.name === errorName
      );
      assert.equal(calls, 0);
    });
  }
});

test('a valid email id is required before counting success', async () => {
  const { service, state } = makeService({
    fetchImpl: async () => response({}, 200)
  });

  await assert.rejects(
    service.send({ source: 'manual', requestId: 'missing-id', subject: 'subject', body: 'body' }),
    error => error.name === 'missing_email_id'
  );
  assert.equal(state.sentToday, 0);
});

test('Resend failure releases its reservation so a later send can use the quota', async () => {
  let calls = 0;
  const { service, state } = makeService({
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response({ name: 'rate_limit_exceeded', message: 'try later' }, 429);
      return response({ id: 'recovered-email' });
    }
  });

  await assert.rejects(service.send({ source: 'desire', requestId: 'failed', subject: 'subject', body: 'body' }));
  assert.equal(state.sentToday, 0);
  const result = await service.send({ source: 'todo', requestId: 'recovered', subject: 'subject', body: 'body' });
  assert.equal(result.emailId, 'recovered-email');
  assert.equal(state.sentToday, 1);
});

test('concurrent sends reserve quota before Resend and never exceed the limit', async () => {
  const pending = [];
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const { service, state } = makeService({
    state: { enabled: true, maxPerDay: 2, recipient: 'a@example.com', senderName: 'WarmBuddy', sentToday: 0, sentDate: '2026-10-02' },
    fetchImpl: async () => new Promise(resolve => {
      pending.push(resolve);
      if (pending.length === 2) resolveStarted();
    })
  });

  const attempts = [1, 2, 3].map(index => service.send({
    source: 'manual', requestId: 'concurrent-' + index, subject: 'subject', body: 'body'
  }));
  const resultsPromise = Promise.allSettled(attempts);
  await started;

  assert.equal(pending.length, 2);
  assert.equal(state.sentToday, 2);
  pending.forEach((resolve, index) => resolve(response({ id: 'concurrent-email-' + index })));
  const results = await resultsPromise;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.name, 'email_daily_limit_reached');
});

test('persists the shared daily count and date used after a restart', async () => {
  const saved = [];
  const first = makeService({
    state: { enabled: true, maxPerDay: 1, recipient: 'a@example.com', senderName: 'WarmBuddy', sentToday: 0, sentDate: '' },
    persistState: async () => saved.push({ sentToday: firstState.sentToday, sentDate: firstState.sentDate })
  });
  const firstState = first.state;

  await first.service.send({ source: 'manual', requestId: 'persisted', subject: 'subject', body: 'body' });
  assert.deepEqual(saved.at(-1), { sentToday: 1, sentDate: '2026-10-02' });

  const restarted = makeService({
    state: { enabled: true, maxPerDay: 1, recipient: 'a@example.com', senderName: 'WarmBuddy', ...saved.at(-1) },
    fetchImpl: async () => { throw new Error('must not send after restart'); }
  });
  await assert.rejects(
    restarted.service.send({ source: 'todo', requestId: 'after-restart', subject: 'subject', body: 'body' }),
    error => error.name === 'email_daily_limit_reached'
  );
});

test('diagnostics include source and request id but never key or body', async () => {
  const { service, logs } = makeService({
    fetchImpl: async () => response({ name: 'invalid_api_key', message: 'API key is invalid' }, 401)
  });

  await assert.rejects(service.send({
    source: 'todo', requestId: 'diagnostic-request', subject: 'private subject', body: 'private body'
  }));
  const text = JSON.stringify(logs);
  assert.match(text, /todo/);
  assert.match(text, /diagnostic-request/);
  assert.match(text, /invalid_api_key/);
  assert.match(text, /401/);
  assert.doesNotMatch(text, /test-resend-key|private subject|private body/);
});
