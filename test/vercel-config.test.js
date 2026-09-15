const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));

test('Vercel config keeps public static output and explicitly builds the API proxy', () => {
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'public');
  assert.ok(config.functions && config.functions['api/*.js']);
  assert.equal(config.routes, undefined);
});
