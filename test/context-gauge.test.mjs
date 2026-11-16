import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  contextBadge, contextLevel, cleanContextBadgeMode, DEFAULT_CONTEXT_BADGE_MODE,
  CONTEXT_WARN_PERCENT, CONTEXT_CRITICAL_PERCENT,
} from '../src/renderer/shared/context-gauge.js';

const reading = { usedTokens: 84000, windowSize: 200000, percent: 42.4 };

test('contextBadge: token count by default, full reading in the tooltip', () => {
  assert.equal(DEFAULT_CONTEXT_BADGE_MODE, 'tokens');
  assert.deepEqual(contextBadge(reading),
    { text: '84k / 200k', detail: '42% · 84k / 200k tokens', level: 'normal' });
  assert.equal(contextBadge({ usedTokens: 650000, windowSize: 1000000, percent: 65 }).text, '650k / 1M');
});

test('contextBadge: percent and both modes', () => {
  assert.equal(contextBadge(reading, 'percent').text, '42%');
  assert.equal(contextBadge(reading, 'both').text, '42% · 84k / 200k');
});

test('contextBadge: falls back to whichever half is known', () => {
  const tokensOnly = { usedTokens: 1234, windowSize: null, percent: null };
  assert.deepEqual(contextBadge(tokensOnly, 'percent'), { text: '1.2k', detail: '1.2k tokens', level: 'normal' });
  assert.equal(contextBadge({ usedTokens: null, windowSize: null, percent: 7 }).text, '7%');
  assert.equal(contextBadge({ usedTokens: null, windowSize: null, percent: 7 }, 'both').text, '7%');
});

test('contextBadge: percentage clamps to 0..100', () => {
  assert.equal(contextBadge({ usedTokens: null, windowSize: null, percent: 140 }).text, '100%');
});

test('contextBadge: nothing to show yet -> null', () => {
  assert.equal(contextBadge(null), null);
  assert.equal(contextBadge({ usedTokens: null, windowSize: null, percent: null }), null);
});

test('cleanContextBadgeMode: unknown or missing -> the default', () => {
  assert.equal(cleanContextBadgeMode('percent'), 'percent');
  assert.equal(cleanContextBadgeMode('bogus'), 'tokens');
  assert.equal(cleanContextBadgeMode(null), 'tokens');
});

test('contextLevel: warns, then turns critical, as the window fills', () => {
  assert.equal(contextLevel(null), 'normal');
  assert.equal(contextLevel(CONTEXT_WARN_PERCENT - 1), 'normal');
  assert.equal(contextLevel(CONTEXT_WARN_PERCENT), 'warn');
  assert.equal(contextLevel(CONTEXT_CRITICAL_PERCENT), 'critical');
});
