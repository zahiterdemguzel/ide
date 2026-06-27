import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, nearestMatch, stepMatch } from '../src/renderer/shared/find.js';

test('findMatches: finds all non-overlapping occurrences', () => {
  const m = findMatches('abcabcabc', 'abc');
  assert.deepEqual(m, [
    { start: 0, end: 3 },
    { start: 3, end: 6 },
    { start: 6, end: 9 },
  ]);
});

test('findMatches: non-overlapping (aa in aaaa is two, not three)', () => {
  const m = findMatches('aaaa', 'aa');
  assert.deepEqual(m, [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
});

test('findMatches: case-insensitive by default, case-sensitive on request', () => {
  assert.equal(findMatches('Foo foo FOO', 'foo').length, 3);
  assert.deepEqual(findMatches('Foo foo FOO', 'foo', true), [{ start: 4, end: 7 }]);
});

test('findMatches: empty query matches nothing', () => {
  assert.deepEqual(findMatches('anything', ''), []);
});

test('findMatches: slice of a match equals the query (end is exclusive)', () => {
  const text = 'const x = find(y)';
  const [hit] = findMatches(text, 'find');
  assert.equal(text.slice(hit.start, hit.end), 'find');
});

test('findMatches: Turkish letters match case-insensitively', () => {
  assert.equal(findMatches('Şçöü güzel', 'şçöü').length, 1);
  assert.equal(findMatches('GÜZEL', 'güzel').length, 1);
});

test('findMatches: a İ before a hit does not shift later match offsets', () => {
  // Regression: "İ".toLowerCase() is two code units, which used to push every
  // later match index off by one and corrupt the editor's highlights.
  const text = 'İstanbul güzel, GÜZEL günü';
  const slices = findMatches(text, 'güzel').map((m) => text.slice(m.start, m.end));
  assert.deepEqual(slices, ['güzel', 'GÜZEL']);
});

test('findMatches: lowercase query finds an İ-cased hit', () => {
  const text = 'İstanbul';
  const [hit] = findMatches(text, 'istanbul');
  assert.equal(text.slice(hit.start, hit.end), 'İstanbul');
});

test('nearestMatch: first match at or after the caret', () => {
  const matches = [{ start: 2 }, { start: 10 }, { start: 20 }];
  assert.equal(nearestMatch(matches, 0), 0);
  assert.equal(nearestMatch(matches, 3), 1);
  assert.equal(nearestMatch(matches, 10), 1);
});

test('nearestMatch: caret past the last match wraps to the top', () => {
  assert.equal(nearestMatch([{ start: 2 }, { start: 10 }], 50), 0);
});

test('nearestMatch: no matches returns -1', () => {
  assert.equal(nearestMatch([], 0), -1);
});

test('stepMatch: wraps both directions', () => {
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0);  // next past the end wraps to first
  assert.equal(stepMatch(0, 3, -1), 2); // prev before the start wraps to last
  assert.equal(stepMatch(-1, 0, 1), -1); // empty list
});
