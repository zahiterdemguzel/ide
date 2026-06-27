const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUsageHeaders, formatResetShort, usageView, resetMs } = require('../src/main/usage-parse');

// A live header bag, shaped like the unified rate-limit headers a real /v1/messages
// response carries (verified against the API: utilization is a 0..1 string, reset is
// epoch SECONDS as a string).
function headers(over = {}) {
  return {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.78',
    'anthropic-ratelimit-unified-5h-reset': '1782559800',
    'anthropic-ratelimit-unified-7d-utilization': '0.16',
    'anthropic-ratelimit-unified-7d-reset': '1783062000',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    ...over,
  };
}

test('parseUsageHeaders: reads both windows, clamps utilization, maps the claim', () => {
  const out = parseUsageHeaders(headers());
  assert.deepEqual(out.windows, [
    { key: '5h', utilization: 0.78, resetAt: 1782559800 * 1000 },
    { key: '7d', utilization: 0.16, resetAt: 1783062000 * 1000 },
  ]);
  assert.equal(out.representative, '5h');
});

test('parseUsageHeaders: maps seven_day to the weekly window key', () => {
  assert.equal(parseUsageHeaders(headers({ 'anthropic-ratelimit-unified-representative-claim': 'seven_day' })).representative, '7d');
});

test('parseUsageHeaders: unknown / missing claim leaves representative null', () => {
  assert.equal(parseUsageHeaders(headers({ 'anthropic-ratelimit-unified-representative-claim': 'whatever' })).representative, null);
  const noClaim = headers(); delete noClaim['anthropic-ratelimit-unified-representative-claim'];
  assert.equal(parseUsageHeaders(noClaim).representative, null);
});

test('parseUsageHeaders: clamps out-of-range utilization into 0..1', () => {
  const out = parseUsageHeaders(headers({ 'anthropic-ratelimit-unified-5h-utilization': '1.4', 'anthropic-ratelimit-unified-7d-utilization': '-0.2' }));
  assert.equal(out.windows[0].utilization, 1);
  assert.equal(out.windows[1].utilization, 0);
});

test('parseUsageHeaders: returns null when the unified headers are absent', () => {
  assert.equal(parseUsageHeaders({}), null);
  assert.equal(parseUsageHeaders({ 'content-type': 'application/json' }), null);
});

test('parseUsageHeaders: keeps a window even when its reset is missing', () => {
  const h = headers(); delete h['anthropic-ratelimit-unified-5h-reset'];
  const out = parseUsageHeaders(h);
  assert.equal(out.windows[0].resetAt, null);
  assert.equal(out.windows[1].resetAt, 1783062000 * 1000);
});

test('resetMs: accepts epoch seconds or an ISO string, else null', () => {
  assert.equal(resetMs('1782559800'), 1782559800 * 1000);
  assert.equal(resetMs('2026-06-27T00:00:00Z'), Date.parse('2026-06-27T00:00:00Z'));
  assert.equal(resetMs(''), null);
  assert.equal(resetMs(undefined), null);
  assert.equal(resetMs('not-a-date'), null);
});

test('formatResetShort: compact minutes / hours / days, and "now" once elapsed', () => {
  const now = 1_000_000_000_000;
  assert.equal(formatResetShort(now + 24 * 60 * 1000, now), '24m');
  assert.equal(formatResetShort(now + 13 * 3600 * 1000, now), '13h');
  assert.equal(formatResetShort(now + 2 * 86400 * 1000, now), '2d');
  assert.equal(formatResetShort(now - 5000, now), 'now');
  assert.equal(formatResetShort(now + 20 * 1000, now), '1m'); // sub-minute rounds up to 1m, never 0m
  assert.equal(formatResetShort(null, now), '');
});

test('usageView: assembles the renderer model with reset tokens and the bottleneck flag', () => {
  const now = 1782559800 * 1000 - 24 * 60 * 1000; // 24 minutes before the 5h reset
  const view = usageView(headers(), now);
  assert.deepEqual(view.windows.map((w) => w.key), ['5h', '7d']);
  assert.equal(view.windows[0].utilization, 0.78);
  assert.equal(view.windows[0].resetIn, '24m');
  assert.equal(view.windows[0].representative, true);
  assert.equal(view.windows[1].representative, false);
});

test('usageView: null headers -> null (the meter hides)', () => {
  assert.equal(usageView({}, 0), null);
});
