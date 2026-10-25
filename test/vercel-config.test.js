const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vercel.json'), 'utf8'));

test('Vercel config keeps public static output and explicitly builds the API proxy', () => {
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.deepEqual(config.functions, {
    'api/proxy.js': { maxDuration: 300 },
    'api/codex-stream.js': { maxDuration: 300, supportsCancellation: true }
  });
  assert.equal(config.routes, undefined);
});

test('Codex stream rewrites before other API paths and other APIs keep the shared proxy', () => {
  assert.deepEqual(config.rewrites, [
    {
      source: '/api/codex/stream',
      destination: '/api/codex-stream?__warmbuddy_path=/api/codex/stream'
    },
    {
      source: '/api/:path*',
      destination: '/api/proxy?__warmbuddy_path=/api/:path*'
    }
  ]);
  assert.equal(fs.existsSync(path.join(projectRoot, 'api', 'proxy.js')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'api', 'codex-stream.js')), true);
  assert.equal(fs.existsSync(path.join(projectRoot, 'api', '[...path].js')), false);
});
