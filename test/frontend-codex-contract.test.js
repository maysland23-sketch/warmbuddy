const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');

test('Codex project is independently registered and loaded after ChatModule', () => {
  const appCore = read('public/js/app-core.js');
  const index = read('public/index.html');
  assert.match(appCore, /codex-code-test/);
  assert.match(appCore, /codex-gateway/);
  assert.match(index, /js\/codex\.js/);
  assert.ok(index.indexOf('js/chat.js') < index.indexOf('js/codex.js'));
});

test('Codex branch uses only the named Codex route and does not alter Claude route construction', () => {
  const chat = read('public/js/chat.js');
  const codex = read('public/js/codex.js');
  assert.match(chat, /CodexModule/);
  assert.match(codex, /\/api\/codex\/stream/);
  assert.match(chat, /\/api\/agent\/stream/);
  assert.match(chat, /\/api\/chat\/stream/);
  assert.doesNotMatch(codex, /Authorization\s*:/);
  assert.doesNotMatch(codex, /gatewayUrl|gatewayToken|privateThreadId/);
});

test('Codex session sidecar is excluded from backup export/import and never enters message sync', () => {
  const backup = read('public/js/backup.js');
  const sync = read('public/js/sync.js');
  assert.match(backup, /codex-session/);
  assert.match(backup, /pending-disconnect/);
  assert.match(sync, /codex-gateway/);
  assert.doesNotMatch(sync, /metadata[^\n]*sessionId/);
});

test('project and chat switching refreshes settings before Codex UI is rendered', () => {
  const chat = read('public/js/chat.js');
  assert.match(chat, /function selectProject\([\s\S]*?updateSettingsUI\(\)[\s\S]*?getModule\('codex'\)/);
  assert.match(chat, /function selectChat\([\s\S]*?updateSettingsUI\(\)[\s\S]*?getModule\('codex'\)/);
});
