const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appCoreSource = fs.readFileSync('public/js/app-core.js', 'utf8');

test('app initialization awaits local Codex reload reconciliation before cloud merge', () => {
  const codexIndex = appCoreSource.indexOf("var codex = AppCore.getModule('codex');");
  const markIndex = appCoreSource.indexOf('codex.markReloadedTurnsUnknown()', codexIndex);
  const syncIndex = appCoreSource.indexOf("var sync = AppCore.getModule('sync');", codexIndex);
  const reconcileIndex = appCoreSource.indexOf('sync.reconcileFromBackend()', syncIndex);

  assert.ok(codexIndex >= 0);
  assert.ok(markIndex >= 0);
  assert.ok(syncIndex > markIndex);
  assert.ok(reconcileIndex > markIndex);
  assert.match(
    appCoreSource.slice(markIndex - 40, markIndex + 80),
    /await codex\.markReloadedTurnsUnknown\(\)/
  );
});
