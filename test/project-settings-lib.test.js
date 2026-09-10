const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, sanitizeMap, projectSettings, withProjectSetting } = require('../src/main/project-settings-lib');

const A = 'C:/work/alpha';
const B = 'C:/work/beta';

test('projectSettings: an unknown project is all defaults', () => {
  assert.deepEqual(projectSettings({}, A), DEFAULTS);
  assert.equal(projectSettings({}, A).useWorktrees, false);
});

test('projectSettings: a stored flag wins over the default', () => {
  assert.equal(projectSettings({ [A]: { useWorktrees: true } }, A).useWorktrees, true);
});

test('projectSettings: tolerates a missing map or repo', () => {
  assert.deepEqual(projectSettings(null, A), DEFAULTS);
  assert.deepEqual(projectSettings({ [A]: { useWorktrees: true } }, null), DEFAULTS);
});

test('withProjectSetting: set then read round-trips', () => {
  const map = withProjectSetting({}, A, 'useWorktrees', true);
  assert.equal(projectSettings(map, A).useWorktrees, true);
});

test('withProjectSetting: does not mutate the input map', () => {
  const map = {};
  withProjectSetting(map, A, 'useWorktrees', true);
  assert.deepEqual(map, {});
});

test('withProjectSetting: projects are independent', () => {
  const map = withProjectSetting({}, A, 'useWorktrees', true);
  assert.equal(projectSettings(map, B).useWorktrees, false);
});

// Back at the default means "nothing to remember" — otherwise the file grows an
// entry for every folder the user ever opened and toggled twice.
test('withProjectSetting: a value back at its default drops the entry', () => {
  const on = withProjectSetting({}, A, 'useWorktrees', true);
  const off = withProjectSetting(on, A, 'useWorktrees', false);
  assert.deepEqual(off, {});
  assert.equal(projectSettings(off, A).useWorktrees, false);
});

test('withProjectSetting: keeps other projects when one entry is dropped', () => {
  let map = withProjectSetting({}, A, 'useWorktrees', true);
  map = withProjectSetting(map, B, 'useWorktrees', true);
  map = withProjectSetting(map, A, 'useWorktrees', false);
  assert.deepEqual(Object.keys(map), [B]);
});

test('withProjectSetting: ignores unknown keys and non-boolean values', () => {
  assert.deepEqual(withProjectSetting({}, A, 'nope', true), {});
  assert.deepEqual(withProjectSetting({}, A, 'useWorktrees', 'yes'), {});
  assert.deepEqual(withProjectSetting({}, '', 'useWorktrees', true), {});
});

test('sanitizeMap: keeps known boolean flags', () => {
  assert.deepEqual(sanitizeMap({ [A]: { useWorktrees: true } }), { [A]: { useWorktrees: true } });
});

test('sanitizeMap: drops unknown keys, non-boolean values and empty entries', () => {
  assert.deepEqual(sanitizeMap({ [A]: { useWorktrees: 'yes', other: 1 } }), {});
  assert.deepEqual(sanitizeMap({ [A]: { other: true } }), {});
});

// The file is hand-editable and outlives version changes, so anything shaped
// wrong must degrade to "no settings" rather than throw on load.
test('sanitizeMap: rejects non-object shapes', () => {
  assert.deepEqual(sanitizeMap(null), {});
  assert.deepEqual(sanitizeMap('nope'), {});
  assert.deepEqual(sanitizeMap([1, 2]), {});
  assert.deepEqual(sanitizeMap({ [A]: null }), {});
  assert.deepEqual(sanitizeMap({ [A]: ['useWorktrees'] }), {});
  assert.deepEqual(sanitizeMap({ '': { useWorktrees: true } }), {});
});
