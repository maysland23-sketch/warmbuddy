const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vercel.json'), 'utf8'));

test('Vercel config keeps public static output and explicitly builds the API proxy', () => {
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.functions && config.functions['api/*.js']);
  assert.equal(config.routes, undefined);
});

test('all API paths rewrite to the fixed proxy Function', () => {
  assert.deepEqual(config.rewrites, [
    {
      source: '/api/:path*',
      destination: '/api/proxy?__warmbuddy_path=/api/:path*'
    }
  ]);
  assert.equal(fs.existsSync(path.join(projectRoot, 'api', 'proxy.js')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'api', '[...path].js')), false);
});
