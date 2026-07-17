const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EFFORT_LEVELS, CODEX_EFFORT_LEVELS, effortLevelsFor, cleanEffort, effortArgs, codexEffortValue, defaultEffortFor } = require('../src/main/agent-effort');

test('every offered level is a spawn flag', () => {
  for (const level of EFFORT_LEVELS) {
    assert.deepEqual(effortArgs(level), ['--effort', level]);
  }
});

test('auto, empty and absent mean no flag at all (the CLI picks)', () => {
  assert.deepEqual(effortArgs('auto'), []);
  assert.deepEqual(effortArgs(''), []);
  assert.deepEqual(effortArgs(undefined), []);
  assert.deepEqual(effortArgs(null), []);
});

test('an unknown level is dropped, never passed through', () => {
  // Unlike a model alias, an unrecognized --effort is a hard CLI error: forwarding one
  // would leave the session unable to spawn at all.
  assert.deepEqual(effortArgs('ludicrous'), []);
  assert.deepEqual(effortArgs('  '), []);
  assert.deepEqual(effortArgs(42), []);
  assert.equal(cleanEffort('ludicrous'), '');
});

test('a level is normalized before it is used', () => {
  assert.equal(cleanEffort(' High '), 'high');
  assert.deepEqual(effortArgs('XHIGH'), ['--effort', 'xhigh']);
});

test('codex has its own ladder: minimal exists, max does not', () => {
  assert.deepEqual(effortLevelsFor('codex'), CODEX_EFFORT_LEVELS);
  assert.deepEqual(effortLevelsFor('claude'), EFFORT_LEVELS);
  assert.equal(codexEffortValue('minimal'), 'minimal');
  assert.equal(codexEffortValue('max'), ''); // claude-only; would fail the codex spawn
  assert.equal(codexEffortValue(' XHigh '), 'xhigh');
  assert.equal(codexEffortValue('auto'), '');
  assert.equal(codexEffortValue(''), '');
});

test('a new codex session starts on medium; claude on the CLI default', () => {
  assert.equal(defaultEffortFor('codex'), 'medium');
  assert.equal(defaultEffortFor('claude'), '');
  assert.equal(defaultEffortFor(''), '');
  // The default must be a level the codex spawn will actually accept.
  assert.equal(codexEffortValue(defaultEffortFor('codex')), 'medium');
});
