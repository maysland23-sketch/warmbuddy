const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VERCEL = '1';
process.env.NODE_ENV = 'test';
process.env.RENDER = 'true';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.EMAIL_FROM = 'WarmBuddy <notifications@mail.example.com>';
process.env.RENDER_PROXY_SECRET = 'server-secret-at-least-32-bytes-long';
process.env.APP_PUBLIC_ORIGIN = 'https://warmbuddy.vercel.app';

const { RENDER_PROXY_HEADER } = require('../render-api-security');
const app = require('../server');

const TEST_SECRET = 'server-secret-at-least-32-bytes-long';

function startApi() {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function stopApi(server) {
  return new Promise(resolve => server.close(resolve));
}

async function configureEmail(origin) {
  const response = await fetch(origin + '/api/email/config', {
    method: 'POST',
    headers: {
      [RENDER_PROXY_HEADER]: TEST_SECRET,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ recipient: 'recipient@example.com', senderName: 'WarmBuddy' })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
}

async function sendEmail(origin, body) {
  return fetch(origin + '/api/email/send', {
    method: 'POST',
    headers: {
      [RENDER_PROXY_HEADER]: TEST_SECRET,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('Resend failure returns no success and logs request diagnostics without secrets or body', async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const logs = [];
  const api = await startApi();
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    await configureEmail(origin);
    global.fetch = async (url, init) => {
      if (url === 'https://api.resend.com/emails') {
        return new Response(JSON.stringify({
          name: 'invalid_api_key',
          message: 'API key is invalid'
        }), { status: 401, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(url, init);
    };
    console.error = (...args) => logs.push(args);

    const response = await sendEmail(origin, {
      subject: 'Diagnostic subject',
      body: 'Diagnostic body must not be logged'
    });
    const result = await response.json();

    assert.equal(response.status, 500);
    assert.equal(result.ok, undefined);
    assert.equal(result.emailId, undefined);
    assert.match(result.requestId, /^[0-9a-f-]{36}$/);
    const logText = JSON.stringify(logs);
    assert.match(logText, new RegExp(result.requestId));
    assert.match(logText, /401/);
    assert.match(logText, /invalid_api_key/);
    assert.match(logText, /API key is invalid/);
    assert.doesNotMatch(logText, /test-resend-key|Diagnostic body must not be logged/);
  } finally {
    console.error = originalError;
    global.fetch = originalFetch;
    await stopApi(api);
  }
});

test('Resend success returns the accepted email id and request diagnostics', async () => {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const logs = [];
  let resendPayload;
  const api = await startApi();
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    global.fetch = async (url, init) => {
      if (url === 'https://api.resend.com/emails') {
        resendPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ id: 'resend-email-id-123' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return originalFetch(url, init);
    };
    console.log = (...args) => logs.push(args);

    const response = await sendEmail(origin, {
      subject: 'Diagnostic success subject',
      body: 'Diagnostic success body must not be logged'
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.emailId, 'resend-email-id-123');
    assert.equal(resendPayload.from, 'WarmBuddy <notifications@mail.example.com>');
    assert.match(result.requestId, /^[0-9a-f-]{36}$/);
    const logText = JSON.stringify(logs);
    assert.match(logText, new RegExp(result.requestId));
    assert.match(logText, /200/);
    assert.match(logText, /resend-email-id-123/);
    assert.doesNotMatch(logText, /test-resend-key|Diagnostic success body must not be logged/);
  } finally {
    console.log = originalLog;
    global.fetch = originalFetch;
    await stopApi(api);
  }
});
