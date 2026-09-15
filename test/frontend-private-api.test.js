const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '..');

test('deployed frontend uses same-origin API and contains no Render API origin', () => {
  const appCore = fs.readFileSync(path.join(repo, 'public/js/app-core.js'), 'utf8');
  const memory = fs.readFileSync(path.join(repo, 'public/js/memory.js'), 'utf8');
  const publicSources = fs.readdirSync(path.join(repo, 'public', 'js'))
    .filter(name => name.endsWith('.js'))
    .map(name => fs.readFileSync(path.join(repo, 'public', 'js', name), 'utf8'))
    .join('\n');
  assert.match(appCore, /var BACKEND_URL[\s\S]*?:\s*'';/);
  assert.doesNotMatch(publicSources, /warmbuddy\.onrender\.com/);
  assert.doesNotMatch(publicSources, /RENDER_PROXY_SECRET|x-warmbuddy-proxy-secret/i);
  assert.doesNotMatch(memory, /https:\/\/warmbuddy\.onrender\.com/);
});

test('sanitized server tool metadata does not erase the local MCP token', () => {
  const source = fs.readFileSync(path.join(repo, 'public/js/toolkit.js'), 'utf8');
  const context = {
    console,
    AppCore: {
      register(_name, module) { context.ToolkitModule = module; },
      getStore() { return { _toolDefinitions: [] }; }
    }
  };
  vm.runInNewContext(source, context);
  assert.equal(typeof context.ToolkitModule.mergeServerDefinition, 'function');

  const merged = context.ToolkitModule.mergeServerDefinition({
    id: 'reader',
    name: 'Old name',
    auth: { type: 'bearer', token: 'LOCAL_TOKEN_SENTINEL' }
  }, {
    id: 'reader',
    name: 'New name',
    auth: { type: 'bearer', configured: true }
  });
  assert.equal(merged.name, 'New name');
  assert.equal(merged.auth.token, 'LOCAL_TOKEN_SENTINEL');
  assert.equal(merged.auth.configured, true);
});
