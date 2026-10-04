const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appCoreSource = fs.readFileSync('public/js/app-core.js', 'utf8');

test('startup reconciles backend state before the initial outbound project sync', () => {
  const initStart = appCoreSource.indexOf("var sync = AppCore.getModule('sync');");
  const reconcileIndex = appCoreSource.indexOf('sync.reconcileFromBackend()', initStart);
  const syncIndex = appCoreSource.indexOf('sync.syncProjectConfigToBackend()', initStart);

  assert.ok(initStart >= 0);
  assert.ok(reconcileIndex >= 0);
  assert.ok(syncIndex >= 0);
  assert.ok(reconcileIndex < syncIndex);
  assert.match(appCoreSource, /await sync\.reconcileFromBackend\(\)/);
});
