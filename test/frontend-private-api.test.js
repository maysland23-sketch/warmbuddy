const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
