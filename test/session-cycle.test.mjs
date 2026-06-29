import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSessionId } from '../src/renderer/shared/session-cycle.js';

test('cycles forward through the list', () => {
  assert.equal(nextSessionId(['a', 'b', 'c'], 'a', 1), 'b');
  assert.equal(nextSessionId(['a', 'b', 'c'], 'b', 1), 'c');
});

test('cycles backward through the list', () => {
  assert.equal(nextSessionId(['a', 'b', 'c'], 'c', -1), 'b');
  assert.equal(nextSessionId(['a', 'b', 'c'], 'b', -1), 'a');
});

test('wraps around both ends', () => {
  assert.equal(nextSessionId(['a', 'b', 'c'], 'c', 1), 'a');
  assert.equal(nextSessionId(['a', 'b', 'c'], 'a', -1), 'c');
});

test('defaults to forward direction', () => {
  assert.equal(nextSessionId(['a', 'b'], 'a'), 'b');
});

test('returns null when there is a single visible row', () => {
  assert.equal(nextSessionId(['a'], 'a', 1), null);
  assert.equal(nextSessionId(['a'], 'a', -1), null);
});

test('returns null for an empty or missing list', () => {
  assert.equal(nextSessionId([], 'a', 1), null);
  assert.equal(nextSessionId(null, 'a', 1), null);
});

test('jumps to an end when the active id is not visible', () => {
  assert.equal(nextSessionId(['a', 'b', 'c'], 'zzz', 1), 'a');
  assert.equal(nextSessionId(['a', 'b', 'c'], 'zzz', -1), 'c');
  assert.equal(nextSessionId(['a', 'b', 'c'], null, 1), 'a');
});
