const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.join(__dirname, '..');

test('agent-gateway test project does not enter proactive project config sync', () => {
  const sync = fs.readFileSync(path.join(repo, 'public/js/sync.js'), 'utf8');
  assert.match(sync, /runtime/);
  assert.match(sync, /agent-gateway/);
  assert.match(sync, /syncProjectConfigToBackend/);
});

test('Gateway environment variables are documented without a secret value', () => {
  const envExample = fs.readFileSync(path.join(repo, '.env.example'), 'utf8');
  assert.match(envExample, /AGENT_GATEWAY_URL=/);
  assert.match(envExample, /AGENT_GATEWAY_TOKEN=/);
  assert.match(envExample, /AGENT_GATEWAY_TIMEOUT_MS=/);
  assert.match(envExample, /AGENT_GATEWAY_PROJECT_ID=warmbuddy-test/);
});
