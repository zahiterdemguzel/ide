const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStore, applyChanges } = require('../src/main/settings-store-lib');

test('normalizeStore: a missing or malformed file reads as no settings', () => {
  assert.deepEqual(normalizeStore(null), {});
  assert.deepEqual(normalizeStore('oops'), {});
  assert.deepEqual(normalizeStore(['a']), {});
});

test('normalizeStore: keeps only string values', () => {
  assert.deepEqual(normalizeStore({ a: 'x', b: 1, c: null, d: '{"k":true}' }), { a: 'x', d: '{"k":true}' });
});

test('applyChanges: sets and removes keys without touching the rest', () => {
  const store = { theme: 'dark', locale: 'en', stale: '1' };
  const next = applyChanges(store, { set: { theme: 'light', added: 'y' }, removed: ['stale'] });
  assert.deepEqual(next, { theme: 'light', locale: 'en', added: 'y' });
  assert.deepEqual(store, { theme: 'dark', locale: 'en', stale: '1' }, 'input is not mutated');
});

test('applyChanges: a key set again in the same batch survives its removal', () => {
  assert.deepEqual(applyChanges({ a: '1' }, { set: { a: '2' }, removed: ['a'] }), { a: '2' });
});

test('applyChanges: two windows changing different keys both keep their change', () => {
  const afterFirst = applyChanges({}, { set: { 'ide.editorSettings': '{"inlineCompletions":false}' } });
  const afterSecond = applyChanges(afterFirst, { set: { 'ide.theme': 'light' } });
  assert.deepEqual(afterSecond, { 'ide.editorSettings': '{"inlineCompletions":false}', 'ide.theme': 'light' });
});

test('applyChanges: ignores malformed batches', () => {
  assert.deepEqual(applyChanges({ a: '1' }, null), { a: '1' });
  assert.deepEqual(applyChanges({ a: '1' }, { set: { b: 2 }, removed: [3] }), { a: '1' });
});
