const { test } = require('node:test');
const assert = require('node:assert/strict');
const { companionPaths } = require('../src/main/companion-files');

test('companionPaths: a script gets its .uid and .import sidecars', () => {
  assert.deepEqual(companionPaths('player.gd'), ['player.gd.uid', 'player.gd.import']);
});

test('companionPaths: any asset extension gets sidecars', () => {
  assert.deepEqual(companionPaths('art/icon.png'), ['art/icon.png.uid', 'art/icon.png.import']);
  assert.deepEqual(companionPaths('models/ship.glb'), ['models/ship.glb.uid', 'models/ship.glb.import']);
});

test('companionPaths: a sidecar has no sidecar of its own', () => {
  assert.deepEqual(companionPaths('player.gd.uid'), []);
  assert.deepEqual(companionPaths('art/icon.png.import'), []);
});
