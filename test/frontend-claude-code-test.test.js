const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');

test('frontend source defines and preserves the stable Claude Code test project', () => {
  const appCore = fs.readFileSync(path.join(repo, 'public/js/app-core.js'), 'utf8');
  const chat = fs.readFileSync(path.join(repo, 'public/js/chat.js'), 'utf8');
  const settings = fs.readFileSync(path.join(repo, 'public/js/settings.js'), 'utf8');
  assert.match(appCore, /claude-code-test/);
  assert.match(appCore, /agent-gateway/);
  assert.match(chat, /\/api\/agent\/stream/);
  assert.match(chat, /claude-code-test/);
  assert.match(settings, /claude-code-test/);
});

test('frontend agent route does not send provider credentials or MCP definitions', () => {
  const chat = fs.readFileSync(path.join(repo, 'public/js/chat.js'), 'utf8');
  const routeBlock = chat.match(/var requestBody = agentGatewayProject[\s\S]*?\? \{([\s\S]*?)\n\s*\}\n\s*: \{/);
  assert.ok(routeBlock, 'agent route branch should be present');
  assert.doesNotMatch(routeBlock[1], /apiKey|endpoint|enabledToolDefs|enabledToolIds/);
});
