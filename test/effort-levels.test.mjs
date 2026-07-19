// The session-bar effort badge offers levels; main decides which ones actually work.
// These tests hold the two together: a row the badge offers but main drops would be a
// menu item that silently does nothing when clicked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EFFORTS, CODEX_EFFORTS, DEFAULT_EFFORT, effortsForFamily, effortNameForFamily,
} from '../src/renderer/shared/effort-levels.js';
import agentEffort from '../src/main/agent-effort.js';

const { EFFORT_LEVELS, CODEX_EFFORT_LEVELS, cleanEffort, codexEffortValue, defaultEffortFor } = agentEffort;

const ids = (rows) => rows.map((r) => r.id);

test('the claude ladder is exactly what main accepts, in main order', () => {
  assert.deepEqual(ids(EFFORTS), EFFORT_LEVELS);
  // Every offered level survives main's own filter — nothing here is a dead row.
  for (const level of EFFORT_LEVELS) assert.equal(cleanEffort(level), level);
});

test('the codex ladder is exactly what codex accepts, in codex order', () => {
  assert.deepEqual(ids(CODEX_EFFORTS), CODEX_EFFORT_LEVELS);
  for (const level of CODEX_EFFORT_LEVELS) assert.equal(codexEffortValue(level), level);
});

test('neither ladder offers auto — every row is a level the badge can name', () => {
  assert.ok(!ids(EFFORTS).includes('auto'));
  assert.ok(!ids(CODEX_EFFORTS).includes('auto'));
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

test('every row can be named', () => {
  for (const family of ['claude', 'codex']) {
    for (const row of effortsForFamily(family)) {
      assert.equal(effortNameForFamily(row.id, family), row.name);
      assert.ok(row.hint, `${row.id} needs a hint`);
    }
  }
});

test('the badge never says Auto — it is not a level any longer', () => {
  for (const family of ['claude', 'codex']) {
    for (const id of ['', undefined, 'auto']) {
      assert.notEqual(effortNameForFamily(id, family), 'Auto');
    }
  }
});

test('a level from another build still says what it is, rather than lying', () => {
  assert.equal(effortNameForFamily('ludicrous', 'claude'), 'ludicrous');
  // A codex session carrying claude's `max` is off-ladder here: the name only has to be
  // honest, not offerable. Records are normalized on load, so this is the rare leftover.
  assert.equal(effortNameForFamily('max', 'codex'), 'max');
});

test('the shared fallback is a row on both ladders', () => {
  assert.ok(ids(EFFORTS).includes(DEFAULT_EFFORT));
  assert.ok(ids(CODEX_EFFORTS).includes(DEFAULT_EFFORT));
  assert.equal(DEFAULT_EFFORT, agentEffort.DEFAULT_EFFORT);
});

test('a new session starts on a level its own ladder can show', () => {
  for (const family of ['codex', 'claude']) {
    for (const remembered of ['', 'max', 'auto', 'high']) {
      const start = defaultEffortFor(family, remembered);
      assert.ok(ids(effortsForFamily(family)).includes(start), `${family}/${remembered} off-ladder`);
    }
  }
});
