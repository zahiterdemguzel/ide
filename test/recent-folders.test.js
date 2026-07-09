const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addRecent, removeRecent, MAX_RECENT } = require('../src/main/recent-folders');

test('addRecent: prepends a new folder', () => {
  assert.deepEqual(addRecent(['/a', '/b'], '/c'), ['/c', '/a', '/b']);
});

test('addRecent: moves an existing folder to the front (no duplicate)', () => {
  assert.deepEqual(addRecent(['/a', '/b', '/c'], '/c'), ['/c', '/a', '/b']);
});

test('addRecent: caps the list at MAX_RECENT, dropping the oldest', () => {
  const list = Array.from({ length: MAX_RECENT }, (_, i) => `/p${i}`);
  const out = addRecent(list, '/new');
  assert.equal(out.length, MAX_RECENT);
  assert.equal(out[0], '/new');
  assert.ok(!out.includes(`/p${MAX_RECENT - 1}`), 'oldest entry dropped');
});

test('addRecent: ignores empty/non-string folders', () => {
  assert.deepEqual(addRecent(['/a'], ''), ['/a']);
  assert.deepEqual(addRecent(['/a'], null), ['/a']);
});

test('addRecent: filters garbage out of the existing list', () => {
  assert.deepEqual(addRecent(['/a', '', null, 5, '/b'], '/c'), ['/c', '/a', '/b']);
});

test('addRecent: tolerates a non-array list', () => {
  assert.deepEqual(addRecent(undefined, '/a'), ['/a']);
});

test('removeRecent: drops the given folder', () => {
  assert.deepEqual(removeRecent(['/a', '/b', '/c'], '/b'), ['/a', '/c']);
});

test('removeRecent: a missing folder leaves the list unchanged', () => {
  assert.deepEqual(removeRecent(['/a', '/b'], '/x'), ['/a', '/b']);
});

test('removeRecent: scrubs garbage while filtering', () => {
  assert.deepEqual(removeRecent(['/a', '', null, 5, '/b'], '/a'), ['/b']);
});

test('removeRecent: tolerates a non-array list', () => {
  assert.deepEqual(removeRecent(undefined, '/a'), []);
});
