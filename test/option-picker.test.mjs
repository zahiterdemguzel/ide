import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOptions, rankOptions, initialActiveIndex, stepActiveIndex,
} from '../src/renderer/shared/option-picker.js';

const labels = (ranked) => ranked.map((r) => r.option.label);

test('normalizeOptions: strings and { label, value } flatten to one shape', () => {
  const opts = normalizeOptions(['dev', { label: 'Production', value: 'prod' }, { value: 'qa' }], 'prod');
  assert.deepEqual(opts, [
    { label: 'dev', value: 'dev', isDefault: false },
    { label: 'Production', value: 'prod', isDefault: true },
    { label: 'qa', value: 'qa', isDefault: false },
  ]);
});

test('rankOptions: empty query keeps the config order', () => {
  const opts = normalizeOptions(['zeta', 'alpha', 'mid']);
  assert.deepEqual(labels(rankOptions('', opts)), ['zeta', 'alpha', 'mid']);
  assert.deepEqual(labels(rankOptions('   ', opts)), ['zeta', 'alpha', 'mid']);
});

test('rankOptions: filters to fuzzy matches, best first', () => {
  const opts = normalizeOptions(['server-debug', 'client', 'server', 'scripts/dev']);
  const ranked = rankOptions('serv', opts);
  assert.deepEqual(labels(ranked), ['server', 'server-debug']);
  assert.deepEqual(ranked[0].positions, [0, 1, 2, 3]);
  assert.deepEqual(rankOptions('xyz', opts), []);
});

test('rankOptions: equal scores keep the original order', () => {
  const opts = normalizeOptions(['run b', 'run a']);
  assert.deepEqual(labels(rankOptions('run', opts)), ['run b', 'run a']);
});

test('initialActiveIndex: default row before typing, best match after', () => {
  const opts = normalizeOptions(['a', 'b', 'c'], 'c');
  assert.equal(initialActiveIndex(rankOptions('', opts), ''), 2);
  assert.equal(initialActiveIndex(rankOptions('', normalizeOptions(['a', 'b'])), ''), 0);
  assert.equal(initialActiveIndex(rankOptions('b', opts), 'b'), 0);
  assert.equal(initialActiveIndex([], 'zzz'), -1);
});

test('stepActiveIndex: moves and wraps at both ends', () => {
  assert.equal(stepActiveIndex(0, 1, 3), 1);
  assert.equal(stepActiveIndex(2, 1, 3), 0);
  assert.equal(stepActiveIndex(0, -1, 3), 2);
  assert.equal(stepActiveIndex(-1, 1, 3), 0);
  assert.equal(stepActiveIndex(-1, -1, 3), 2);
  assert.equal(stepActiveIndex(0, 1, 0), -1);
});
