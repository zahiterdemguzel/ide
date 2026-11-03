const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DiskBackedMap, isUnloaded } = require('../src/main/disk-backed-map');

function counted(stored) {
  const loader = () => { loader.calls++; return new Map(stored); };
  loader.calls = 0;
  return loader;
}

test('DiskBackedMap: key-only reads never load the values', () => {
  const load = counted([['/a', [1]], ['/b', [2]]]);
  const map = new DiskBackedMap(['/a', '/b'], load);
  assert.equal(map.size, 2);
  assert.equal(map.has('/a'), true);
  assert.equal(map.has('/zzz'), false);
  assert.deepEqual([...map.keys()], ['/a', '/b']);
  assert.equal(map.delete('/b'), true);
  assert.equal(load.calls, 0);
  assert.equal(isUnloaded(map), true);
});

test('DiskBackedMap: reading a value loads once, then acts as a plain Map', () => {
  const load = counted([['/a', [1]], ['/b', [2]]]);
  const map = new DiskBackedMap(['/a', '/b'], load);
  assert.deepEqual(map.get('/a'), [1]);
  assert.deepEqual([...map.values()], [[1], [2]]);
  assert.deepEqual([...map], [['/a', [1]], ['/b', [2]]]);
  map.set('/c', [3]);
  assert.deepEqual([...map.entries()].map(([k]) => k), ['/a', '/b', '/c']);
  assert.equal(load.calls, 1);
  assert.equal(isUnloaded(map), false);
});

test('DiskBackedMap: a key deleted before the load stays deleted', () => {
  const map = new DiskBackedMap(['/a', '/b'], counted([['/a', [1]], ['/b', [2]]]));
  map.delete('/a');
  assert.deepEqual([...map], [['/b', [2]]]);
});

test('DiskBackedMap: a key missing from the stored values, or a failed load, gets an empty value', () => {
  const partial = new DiskBackedMap(['/a', '/b'], counted([['/a', [1]]]));
  assert.deepEqual(partial.get('/b'), []);
  const failing = new DiskBackedMap(['/a'], () => { throw new Error('gone'); });
  assert.deepEqual(failing.get('/a'), []);
});

test('isUnloaded: false for plain Maps', () => {
  assert.equal(isUnloaded(new Map()), false);
  assert.equal(isUnloaded(undefined), false);
});
