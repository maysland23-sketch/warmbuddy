const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const envKeys = [
  'VERCEL', 'NODE_ENV', 'RENDER', 'SUPABASE_URL', 'SUPABASE_KEY',
  'RESEND_API_KEY', 'EMAIL_FROM', 'RENDER_PROXY_SECRET', 'APP_PUBLIC_ORIGIN'
];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

for (const [key, value] of Object.entries({
  VERCEL: '1',
  NODE_ENV: 'test',
  RENDER: 'true',
  SUPABASE_URL: 'https://supabase.example.test',
  SUPABASE_KEY: 'supabase-test-key',
  RESEND_API_KEY: 'resend-test-key',
  EMAIL_FROM: 'WarmBuddy <notifications@mail.example.com>',
  RENDER_PROXY_SECRET: 'server-secret-at-least-32-bytes-long',
  APP_PUBLIC_ORIGIN: 'https://warmbuddy.vercel.app'
})) process.env[key] = value;

function failingSupabaseClient() {
  const persistenceError = { name: 'storage_unavailable', message: 'database write failed' };
  function query() {
    return {
      select: () => query(),
      eq: () => query(),
      single: async () => ({ data: null, error: null }),
      upsert: async () => ({ error: persistenceError })
    };
  }
  return { from: () => query() };
}

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => failingSupabaseClient() };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { RENDER_PROXY_HEADER } = require('../render-api-security');
const app = require('../server');
Module._load = originalLoad;

const secret = process.env.RENDER_PROXY_SECRET;

function requestJson(origin, path, body) {
  return fetch(origin + path, {
    method: 'POST',
    headers: {
      [RENDER_PROXY_HEADER]: secret,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
}

test('config and settings do not report success when Supabase persistence fails', async () => {
  const api = await new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const origin = `http://127.0.0.1:${api.address().port}`;
  try {
    const configResponse = await requestJson(origin, '/api/email/config', {
      recipient: 'recipient@example.com', senderName: 'WarmBuddy'
    });
    const config = await configResponse.json();
    assert.equal(configResponse.status, 503);
    assert.equal(config.ok, false);
    assert.equal(config.persisted, undefined);

    const settingsResponse = await requestJson(origin, '/api/email/settings', { enabled: false });
    const settings = await settingsResponse.json();
    assert.equal(settingsResponse.status, 503);
    assert.equal(settings.ok, false);
    assert.equal(settings.persisted, undefined);
  } finally {
    await new Promise(resolve => api.close(resolve));
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});
