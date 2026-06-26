const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addRecent, MAX_RECENT } = require('../src/main/recent-folders');

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
