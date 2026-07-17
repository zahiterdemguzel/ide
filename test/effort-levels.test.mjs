// The session-bar effort badge offers levels; main decides which ones actually work.
// These tests hold the two together: a row the badge offers but main drops would be a
// menu item that silently does nothing when clicked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORTS, CODEX_EFFORTS, DEFAULT_EFFORT, effortsForFamily, effortNameForFamily,
} from '../src/renderer/shared/effort-levels.js';
import agentEffort from '../src/main/agent-effort.js';

const { EFFORT_LEVELS, CODEX_EFFORT_LEVELS, cleanEffort, codexEffortValue, defaultEffortFor, AUTO } = agentEffort;

const ids = (rows) => rows.map((r) => r.id);

test('the claude ladder is auto plus exactly what main accepts, in main order', () => {
  assert.deepEqual(ids(EFFORTS), [AUTO, ...EFFORT_LEVELS]);
  // Every offered level survives main's own filter — nothing here is a dead row.
  for (const level of EFFORT_LEVELS) assert.equal(cleanEffort(level), level);
});

test('the codex ladder is auto plus exactly what codex accepts, in codex order', () => {
  assert.deepEqual(ids(CODEX_EFFORTS), [AUTO, ...CODEX_EFFORT_LEVELS]);
  for (const level of CODEX_EFFORT_LEVELS) assert.equal(codexEffortValue(level), level);
});

test('the ladders differ where the CLIs differ: max is claude-only', () => {
  assert.ok(!ids(CODEX_EFFORTS).includes('max'));
  assert.ok(ids(EFFORTS).includes('max'));
});

test('neither badge offers minimal — the API rejects it with codex web_search', () => {
  // A row that 400s the turn is worse than a missing row. Both ladders stay clear of it:
  // codex because it breaks, claude because the level isn't its CLI's to begin with.
  assert.ok(!ids(CODEX_EFFORTS).includes('minimal'));
  assert.ok(!ids(EFFORTS).includes('minimal'));
});

test('a codex session gets the codex ladder; everything else the claude one', () => {
  assert.deepEqual(effortsForFamily('codex'), CODEX_EFFORTS);
  assert.deepEqual(effortsForFamily('claude'), EFFORTS);
  assert.deepEqual(effortsForFamily('ollama'), EFFORTS);
  assert.deepEqual(effortsForFamily(''), EFFORTS);
});

test('every row can be named, and auto is a row rather than a blank', () => {
  for (const family of ['claude', 'codex']) {
    for (const row of effortsForFamily(family)) {
      assert.equal(effortNameForFamily(row.id, family), row.name);
      assert.ok(row.hint, `${row.id} needs a hint`);
    }
  }
  assert.ok(ids(EFFORTS).includes(DEFAULT_EFFORT));
});

test('an unset record shows as Auto — that is what no level set means', () => {
  assert.equal(effortNameForFamily('', 'claude'), 'Auto');
  assert.equal(effortNameForFamily(undefined, 'codex'), 'Auto');
  assert.equal(effortNameForFamily(DEFAULT_EFFORT, 'claude'), 'Auto');
});

test('a level from another build still says what it is, rather than lying', () => {
  assert.equal(effortNameForFamily('ludicrous', 'claude'), 'ludicrous');
  // A codex session carrying claude's `max` (or vice versa) is off-ladder here: the
  // badge falls back to Auto for it, so the name only has to be honest, not offerable.
  assert.equal(effortNameForFamily('max', 'codex'), 'max');
});

test('a new session starts on a level its own ladder can show', () => {
  for (const family of ['codex', 'claude']) {
    const start = defaultEffortFor(family) || DEFAULT_EFFORT;
    assert.ok(ids(effortsForFamily(family)).includes(start), `${family} starts off-ladder`);
  }
});
