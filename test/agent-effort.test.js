const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EFFORT_LEVELS, CODEX_EFFORT_LEVELS, DEFAULT_EFFORT, effortLevelsFor, cleanEffort, effortArgs, codexEffortValue, defaultEffortFor } = require('../src/main/agent-effort');

test('every offered level is a spawn flag', () => {
  for (const level of EFFORT_LEVELS) {
    assert.deepEqual(effortArgs(level), ['--effort', level]);
  }
});

test('empty and absent add no flag — but no session is left holding one', () => {
  // effortArgs is the last step, not the policy: by the time a record reaches it,
  // defaultEffortFor has already turned "nothing" into a real level. These cases are
  // the floor under that, not a state the UI can produce.
  assert.deepEqual(effortArgs(''), []);
  assert.deepEqual(effortArgs(undefined), []);
  assert.deepEqual(effortArgs(null), []);
  assert.deepEqual(effortArgs('auto'), []); // no longer a level; treated as unknown
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

test('codex has its own ladder: no max', () => {
  assert.deepEqual(effortLevelsFor('codex'), CODEX_EFFORT_LEVELS);
  assert.deepEqual(effortLevelsFor('claude'), EFFORT_LEVELS);
  assert.equal(codexEffortValue('max'), ''); // claude-only; would fail the codex spawn
  assert.equal(codexEffortValue(' XHigh '), 'xhigh');
  assert.equal(codexEffortValue('auto'), '');
  assert.equal(codexEffortValue(''), '');
});

test('minimal is not a codex level: the API rejects it alongside web_search', () => {
  // Codex's own lowest stop, but `reasoning.effort: minimal` + the web_search tool Codex
  // sends is a hard 400 — the turn fails outright, so a session on minimal can't answer.
  // Dropping it here is what makes a stale `minimal` record self-heal into Codex's own
  // default rather than spawning a session that errors on every prompt.
  assert.ok(!CODEX_EFFORT_LEVELS.includes('minimal'));
  assert.equal(codexEffortValue('minimal'), '');
});

test('a session starts on the level last picked', () => {
  assert.equal(defaultEffortFor('claude', 'xhigh'), 'xhigh');
  assert.equal(defaultEffortFor('codex', 'low'), 'low');
  assert.equal(defaultEffortFor('claude', ' High '), 'high');
});

test('a remembered level the family cannot run falls back rather than breaking it', () => {
  // `max` is claude-only: carried into a codex session it would fail the spawn outright.
  assert.equal(defaultEffortFor('codex', 'max'), DEFAULT_EFFORT);
  assert.equal(defaultEffortFor('claude', 'max'), 'max');
});

test('nothing remembered still yields a real level — never an unset session', () => {
  // This is the whole point: every session runs at a level its badge can name, so there
  // is no input that resolves to "" and lets the CLI pick unseen.
  for (const family of ['claude', 'codex', 'ollama', '']) {
    for (const remembered of ['', undefined, null, 'auto', 'ludicrous', 42]) {
      const start = defaultEffortFor(family, remembered);
      assert.ok(effortLevelsFor(family).includes(start), `${family}/${remembered} → ${start}`);
    }
  }
});

test('the fallback is a level both ladders can actually run', () => {
  assert.equal(cleanEffort(DEFAULT_EFFORT), DEFAULT_EFFORT);
  assert.equal(codexEffortValue(DEFAULT_EFFORT), DEFAULT_EFFORT);
});
