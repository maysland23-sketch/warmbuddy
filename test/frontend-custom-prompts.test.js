const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appCoreSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-core.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');

test('store defaults and migration keep custom prompt definitions in the existing store', () => {
  assert.match(appCoreSource, /customPrompts:\s*\[\]/);
  assert.match(appCoreSource, /customPromptModule\.normalizeStore\(\)/);
  assert.match(appCoreSource, /customPromptStates/);
  assert.match(appCoreSource, /delete\s+customPromptChat\.customPromptStates\[/);
});

test('all chat creation paths initialize independent disabled prompt state', () => {
  const defaults = chatSource.match(/customPromptRound:\s*0/g) || [];
  assert.ok(defaults.length >= 3, `expected three chat creation defaults, found ${defaults.length}`);
  assert.ok((chatSource.match(/customPromptStates:\s*\{\}/g) || []).length >= 3);
});
