const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staleInstanceDirs } = require('../src/main/instance-lib');

test('staleInstanceDirs: returns dirs whose pid has no living owner', () => {
  const alive = new Set([1000, 2000]);
  const isAlive = (pid) => alive.has(pid);
  assert.deepEqual(
    staleInstanceDirs(['1000', '2000', '3000', '4000'], isAlive),
    ['3000', '4000'],
  );
});

test('staleInstanceDirs: keeps dirs owned by a live sibling instance', () => {
  // A running instance's dir has files locked and an alive pid — never sweep it.
  const isAlive = (pid) => pid === 5555;
  assert.deepEqual(staleInstanceDirs(['5555'], isAlive), []);
});

test('staleInstanceDirs: ignores non-numeric entries (stray files/dirs)', () => {
  const isAlive = () => false;
  assert.deepEqual(
    staleInstanceDirs(['browser-profile', 'instances', '.DS_Store', '123'], isAlive),
    ['123'],
  );
});

test('staleInstanceDirs: empty input yields empty result', () => {
  assert.deepEqual(staleInstanceDirs([], () => false), []);
});
