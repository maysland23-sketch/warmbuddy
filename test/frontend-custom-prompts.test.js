const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appCoreSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-core.js'), 'utf8');
const chatSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'chat.js'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const settingsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'settings.js'), 'utf8');
const uiSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js'), 'utf8');
const customPromptSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'custom-prompts.js'), 'utf8');

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

test('Settings exposes custom prompt controls and loads the module before settings', () => {
  assert.match(indexSource, /id="customPromptList"/);
  assert.match(indexSource, /data-action="showAddCustomPrompt"/);
  assert.ok(indexSource.indexOf('js/custom-prompts.js') < indexSource.indexOf('js/settings.js'));
  assert.match(settingsSource, /renderSettings\(\)/);
});

test('custom prompt actions are delegated and prompt text is escaped in the UI', () => {
  for (const action of ['showAddCustomPrompt', 'saveCustomPrompt', 'editCustomPrompt', 'deleteCustomPrompt', 'toggleCustomPrompt']) {
    assert.match(uiSource, new RegExp("case '" + action + "'"));
  }
  assert.match(customPromptSource, /AppCore\.escapeHtml/);
  assert.match(customPromptSource, /maxlength="3000"/);
  assert.match(customPromptSource, /MIN_INTERVAL\s*=\s*1/);
});
