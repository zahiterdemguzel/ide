const { test } = require('node:test');
const assert = require('node:assert/strict');
const { staleInstanceDirs, liveInstances, upsertInstance } = require('../src/main/instance-lib');

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

const inst = (id, pid, startedAt, project) => ({ id, pid, startedAt, project });

test('liveInstances: oldest first, so the phone lists windows by when they opened', () => {
  const isAlive = () => true;
  const list = liveInstances(
    [inst('b', 2, 3000, '/api'), inst('a', 1, 1000, '/ide'), inst('c', 3, 2000, '/web')],
    isAlive,
  );
  assert.deepEqual(list.map((e) => e.id), ['a', 'c', 'b']);
});

// A window that is killed or crashes never removes its own entry, so the file always
// holds leftovers — offering one would send the phone dialling a window that is gone.
test('liveInstances: drops entries whose process is gone', () => {
  const isAlive = (pid) => pid === 10;
  const list = liveInstances([inst('dead', 9, 1000, '/x'), inst('live', 10, 2000, '/y')], isAlive);
  assert.deepEqual(list.map((e) => e.id), ['live']);
});

test('liveInstances: junk in the file is ignored, never returned', () => {
  const isAlive = () => true;
  assert.deepEqual(liveInstances(null, isAlive), []);
  assert.deepEqual(liveInstances([null, 'x', {}, { id: 'a' }, { pid: 1 }], isAlive), []);
});

// Siblings write the same file, so a publish must not clobber their entries — only
// the publisher's own, keyed by id.
test('upsertInstance: replaces only its own entry and leaves siblings alone', () => {
  const before = [inst('a', 1, 1000, '/ide'), inst('b', 2, 2000, '/api')];
  const after = upsertInstance(before, inst('a', 1, 1000, '/other'));
  assert.equal(after.length, 2);
  assert.equal(after.find((e) => e.id === 'a').project, '/other');
  assert.equal(after.find((e) => e.id === 'b').project, '/api');
});

test('upsertInstance: adds an entry that is not there yet', () => {
  assert.deepEqual(upsertInstance([], inst('a', 1, 1000, '/ide')), [inst('a', 1, 1000, '/ide')]);
  assert.deepEqual(upsertInstance(undefined, inst('a', 1, 1000, '/ide')), [inst('a', 1, 1000, '/ide')]);
});
