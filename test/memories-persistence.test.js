const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMemoryRows } = require('../memories-persistence');

test('deduplicates a POST batch by the memories primary key and keeps the newer version', () => {
  const rows = buildMemoryRows('p1', [
    { id: 'm-1', content: 'newer', updatedAt: '2026-09-15T11:00:00.000Z' },
    { id: 'm-1', content: 'older', updatedAt: '2026-09-15T10:00:00.000Z' },
    { id: 'm-2', content: 'unique' }
  ], '2026-09-15T12:00:00.000Z');

  assert.deepEqual(rows.map(row => row.id), ['m-1', 'm-2']);
  assert.equal(rows[0].content, 'newer');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

test('deduplicates a sync batch across merged memory layers and uses the last occurrence without a version', () => {
  const rows = buildMemoryRows('p1', [
    { id: 'shared-id', content: 'AEM copy', layer: 'ai_emotional' },
    { id: 'shared-id', content: 'USM copy', layer: 'user_starred' },
    { id: 'unique-id', content: 'DLB copy', layer: 'diary_litter' }
  ], '2026-09-15T12:00:00.000Z');

  assert.deepEqual(rows.map(row => row.id), ['shared-id', 'unique-id']);
  assert.equal(rows[0].content, 'USM copy');
  assert.equal(rows[0].layer, 'user_starred');
});

test('treats numeric and string forms of the same text primary key as duplicates', () => {
  const rows = buildMemoryRows('p1', [
    { id: 42, content: 'first' },
    { id: '42', content: 'last' }
  ], '2026-09-15T12:00:00.000Z');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '42');
  assert.equal(rows[0].content, 'last');
});
