import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold } from '../src/renderer/shared/text-fold.js';

test('fold: lowercases ASCII', () => {
  assert.equal(fold('HeLLo'), 'hello');
});

test('fold: folds Turkish accented letters case-insensitively', () => {
  assert.equal(fold('ŞÇÖÜĞ'), fold('şçöüğ'));
  assert.equal(fold('Şçöü'), 'şçöü');
});

test('fold: result is always the same length as the input (offsets stay valid)', () => {
  // "İ" lowercases to two code units via plain toLowerCase; fold keeps it at one
  // so a match offset in the folded string still indexes the original text.
  for (const s of ['İstanbul', 'GÜZEL günü', 'Şçöü ığdır', 'aİbİc', '𝕏Y']) {
    assert.equal(fold(s).length, s.length, `length preserved for ${JSON.stringify(s)}`);
  }
});

test('fold: İ / I both fold to i, so "istanbul" matches "İstanbul"', () => {
  assert.equal(fold('İstanbul'), 'istanbul');
  assert.equal(fold('IGDIR'), 'igdir');
});

test('fold: dotless ı stays distinct from i', () => {
  assert.notEqual(fold('ı'), fold('i'));
  assert.equal(fold('IĞDIR'.toLowerCase()), fold('iğdir')); // sanity: ASCII I path
});

test('fold: handles null / undefined as empty string', () => {
  assert.equal(fold(null), '');
  assert.equal(fold(undefined), '');
});
