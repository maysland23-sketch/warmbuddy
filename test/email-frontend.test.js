const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('email toggle writes the single backend emailState switch', () => {
  const source = fs.readFileSync('public/js/email.js', 'utf8');

  assert.match(source, /\/api\/email\/settings/);
  assert.match(source, /enabled/);
  assert.match(source, /if \(!s\.ok\)/);
});

test('email config UI distinguishes persistence failure from an in-memory update', () => {
  const source = fs.readFileSync('public/js/email.js', 'utf8');

  assert.match(source, /if \(!d\.ok\)/);
  assert.match(source, /d\.persisted === false/);
});

test('manual chat only shows success when the backend returns an email id', () => {
  const source = fs.readFileSync('public/index.html', 'utf8');

  assert.match(source, /if\(data\.ok&&data\.emailId\)/);
});
