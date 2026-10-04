const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const serverSource = fs.readFileSync('server.js', 'utf8');

test('server wires the shared AI status contract into proactive event handling', () => {
  assert.match(serverSource, /require\('\.\/proactive-status-utils'\)/);
  assert.match(serverSource, /isAiStatusEventType\(event\.type\)/);
  assert.match(serverSource, /getStatusEventContent\(\{\s*status:\s*actions\.status,\s*message:\s*visibleMessage/);
});
