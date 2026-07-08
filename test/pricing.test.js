const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ratesFor, costUsd } = require('../src/main/pricing');

test('ratesFor: matches model families by id substring', () => {
  assert.deepEqual(ratesFor('claude-opus-4-8'), { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
  assert.equal(ratesFor('claude-sonnet-5').input, 3);
  assert.equal(ratesFor('claude-haiku-4-5-20251001').input, 1);
  assert.equal(ratesFor('claude-fable-5').input, 10);
  // Older Opus (4.1 and Claude 3 Opus) keep the legacy $15/$75 rate.
  assert.equal(ratesFor('claude-opus-4-1-20250805').input, 15);
  assert.equal(ratesFor('claude-3-opus-20240229').input, 15);
  assert.equal(ratesFor('claude-3-5-haiku-20241022').input, 0.8);
});

test('ratesFor: cache rates derive from input (1.25x write, 0.1x read)', () => {
  const r = ratesFor('claude-sonnet-4-6');
  assert.equal(r.cacheWrite, 3 * 1.25);
  assert.equal(r.cacheRead, 3 * 0.1);
});

test('ratesFor: unknown model yields null', () => {
  assert.equal(ratesFor('gpt-4o'), null);
  assert.equal(ratesFor(''), null);
});

test('costUsd: prices a token bundle per MTok', () => {
  // 1M input + 1M output + 1M cache write + 1M cache read on Haiku 4.5.
  const tokens = { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 };
  assert.equal(costUsd('claude-haiku-4-5', tokens), 1 + 5 + 1.25 + 0.1);
});

test('costUsd: null for unknown model or missing tokens', () => {
  assert.equal(costUsd('mystery-model', { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }), null);
  assert.equal(costUsd('claude-opus-4-8', null), null);
});

test('costUsd: tolerates missing token classes', () => {
  assert.equal(costUsd('claude-opus-4-8', { output: 2e6 }), 50);
});
