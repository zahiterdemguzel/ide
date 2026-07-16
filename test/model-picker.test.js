const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  MODEL_ROWS, EFFORT_STOPS, modelRow, effortStop, modelMoves, effortMoves,
} = require('../src/main/model-picker');

const UP = '\x1b[A';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';

test('picker layout matches the CLI it was established against', () => {
  // Verified live on claude 2.1.211 — if the CLI reorders these, re-probe before editing.
  assert.deepEqual(MODEL_ROWS, ['default', 'opus', 'fable', 'sonnet', 'haiku']);
  assert.deepEqual(EFFORT_STOPS, ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
});

test('aliases and full model ids land on their row', () => {
  assert.equal(modelRow('opus'), 1);
  assert.equal(modelRow(' Fable '), 2);
  assert.equal(modelRow('claude-sonnet-5'), 3);
  assert.equal(modelRow('claude-haiku-4-5-20251001'), 4);
  assert.equal(modelRow('default'), 0);
});

test('unknown, empty and ollama ids have no row', () => {
  assert.equal(modelRow(''), -1);
  assert.equal(modelRow(undefined), -1);
  assert.equal(modelRow('gpt-4'), -1);
  // Ollama never rides the picker: that switch is a respawn (different base URL/auth).
  assert.equal(modelRow('ollama:llama3.1:8b'), -1);
});

test('model moves take the shortest way around a wrapping list', () => {
  assert.equal(modelMoves('fable', 'sonnet'), DOWN);
  assert.equal(modelMoves('fable', 'opus'), UP);
  assert.equal(modelMoves('haiku', 'default'), DOWN); // wraps: 4 -> 0 is one down, not four up
  assert.equal(modelMoves('default', 'haiku'), UP);
  assert.equal(modelMoves('opus', 'opus'), '');
});

test('a model plan needs both ends; otherwise the caller falls back to /model', () => {
  assert.equal(modelMoves('', 'sonnet'), null);
  assert.equal(modelMoves('fable', 'ollama:phi3'), null);
  assert.equal(modelMoves(undefined, undefined), null);
});

test('effort moves walk the slider, wrapping through ultracode', () => {
  assert.equal(effortMoves('medium', 'xhigh'), RIGHT + RIGHT);
  assert.equal(effortMoves('high', 'low'), LEFT + LEFT);
  assert.equal(effortMoves('max', 'max'), '');
  // low -> max: two lefts through the wrap beat four rights.
  assert.equal(effortMoves('low', 'max'), LEFT + LEFT);
  assert.equal(effortMoves('ultracode', 'low'), RIGHT);
});

test('an effort plan needs a known starting stop; auto and unknowns fall back', () => {
  assert.equal(effortMoves('', 'high'), null);
  assert.equal(effortMoves('auto', 'high'), null);
  assert.equal(effortMoves(undefined, 'high'), null);
  assert.equal(effortMoves('medium', 'auto'), null);
  assert.equal(effortStop('ULTRACODE '), 5);
});
