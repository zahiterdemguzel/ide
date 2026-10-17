import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineChanges } from '../src/renderer/editor/line-diff.js';

const join = (...lines) => lines.join('\n');

test('lineChanges: identical text has no changes', () => {
  assert.deepEqual(lineChanges(join('a', 'b'), join('a', 'b')), []);
});

test('lineChanges: added lines', () => {
  assert.deepEqual(lineChanges(join('a', 'b'), join('a', 'x', 'y', 'b')), [{ type: 'added', start: 2, end: 3 }]);
});

test('lineChanges: modified line', () => {
  assert.deepEqual(lineChanges(join('a', 'b', 'c'), join('a', 'B', 'c')), [{ type: 'modified', start: 2, end: 2 }]);
});

test('lineChanges: deleted lines mark the line above, 0 at the top', () => {
  assert.deepEqual(lineChanges(join('a', 'b', 'c'), join('a', 'c')), [{ type: 'deleted', start: 1, end: 1 }]);
  assert.deepEqual(lineChanges(join('a', 'b', 'c'), join('b', 'c')), [{ type: 'deleted', start: 0, end: 0 }]);
});

test('lineChanges: several separate hunks', () => {
  const base = join('1', '2', '3', '4', '5', '6', '7');
  const cur = join('1', 'new', '2', '3', 'four', '5', '7');
  assert.deepEqual(lineChanges(base, cur), [
    { type: 'added', start: 2, end: 2 },
    { type: 'modified', start: 5, end: 5 },
    { type: 'deleted', start: 6, end: 6 },
  ]);
});

test('lineChanges: CRLF vs LF bases compare by line content', () => {
  assert.deepEqual(lineChanges('a\r\nb\r\n', 'a\nb\n'), []);
});

test('lineChanges: a new file against an empty base is all added', () => {
  assert.deepEqual(lineChanges('', join('x', 'y')), [{ type: 'modified', start: 1, end: 2 }]);
});
