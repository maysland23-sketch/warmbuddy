const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function diagnosticLines(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
    .split(/\r?\n/)
    .filter(line => /console\.(?:log|error|warn)\s*\(/.test(line));
}

test('server diagnostics do not log credential values or request/response bodies', () => {
  const lines = diagnosticLines('server.js').join('\n');
  assert.doesNotMatch(lines, /VAPID_(?:PUBLIC|PRIVATE)_KEY\s*[=+]/);
  assert.doesNotMatch(lines, /(?:Raw body|raw body|RAW STREAM|raw sample|mcpRequest body)/i);
  assert.doesNotMatch(lines, /(?:tokenLength|tokenSha256|authorizationLength|authorizationBearerPrefix|authorizationTokenSha256)/);
  assert.doesNotMatch(lines, /JSON\.stringify\((?:req\.)?body\)/);
  assert.doesNotMatch(lines, /Tool result.*resultText\.(?:slice|substring)|subscription\.endpoint\.slice|JSON\.stringify\(parsed\)/);
  assert.doesNotMatch(lines, /\[error\] Stack/);
});

test('Gateway diagnostics do not log token fingerprints or authorization metadata', () => {
  const lines = diagnosticLines('claude-code-gateway.js').join('\n');
  assert.doesNotMatch(lines, /tokenLength|tokenSha256|authorizationLength|authorizationBearerPrefix|authorizationTokenSha256/);
  assert.doesNotMatch(lines, /upstreamBody|authorization\s*:/);
});
