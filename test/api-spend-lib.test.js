'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/main/api-spend-lib');

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('priceKeyFor: the most specific id prefix wins, unknown ids fall back by family', () => {
  assert.equal(lib.priceKeyFor('claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(lib.priceKeyFor('claude-opus-5'), 'claude-opus-5');
  assert.equal(lib.priceKeyFor('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.equal(lib.priceKeyFor('claude-sonnet-4-5-20250929'), 'claude-sonnet-4');
  assert.equal(lib.priceKeyFor('claude-haiku-9'), 'claude-haiku-5-5');
  assert.equal(lib.priceKeyFor('mystery'), 'claude-opus-5-5');
});

test('costOfUsage: input, output, cache reads and both cache-write TTLs', () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read per MTok.
  near(lib.costOfUsage('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  near(lib.costOfUsage('claude-opus-5-5', { cache_read_input_tokens: 1e6 }), 0.2);
  near(lib.costOfUsage('claude-opus-5-5', {
    cache_creation_input_tokens: 2e6,
    cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 },
  }), 4 * 1.25 + 4 * 2);
  // No TTL breakdown: every write is a 5-minute one.
  near(lib.costOfUsage('claude-opus-5-5', { cache_creation_input_tokens: 1e6 }), 5);
  assert.equal(lib.costOfUsage('claude-opus-5-5', null), 0);
});

test('costOfUsage: fast mode doubles tokens, web searches add $10 per thousand', () => {
  near(lib.costOfUsage('claude-opus-5-5', { output_tokens: 1e6, speed: 'fast' }), 40);
  near(lib.costOfUsage('claude-opus-5-5', { server_tool_use: { web_search_requests: 3 } }), 0.03);
});

test('costOfUsage: Haiku 5.5 prompts over 100K tokens bill at five times the rate', () => {
  near(lib.costOfUsage('claude-haiku-5-5', { input_tokens: 50000 }), 0.005);
  near(lib.costOfUsage('claude-haiku-5-5', { input_tokens: 200000 }), 0.1);
});

test('createUsageReader: SSE stream split at awkward points, delta usage overrides start', () => {
  const reader = lib.createUsageReader('text/event-stream; charset=utf-8');
  const stream = 'event: message_start\r\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":1}}}\r\n\r\n'
    + 'event: ping\ndata: {"type":"ping"}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42,"input_tokens":null}}\n\n';
  for (let i = 0; i < stream.length; i += 7) reader.feed(Buffer.from(stream.slice(i, i + 7)));
  assert.deepEqual(reader.result(), {
    model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 42 },
  });
});

test('createUsageReader: an interrupted stream still reports what it got; JSON bodies work; junk is null', () => {
  const cut = lib.createUsageReader('text/event-stream');
  cut.feed(Buffer.from('data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}'));
  assert.deepEqual(cut.result(), { model: 'm', usage: { input_tokens: 3 } });
  const json = lib.createUsageReader('application/json');
  json.feed(Buffer.from('{"model":"claude-opus-5-5","usage":{"input_tokens":1,'));
  json.feed(Buffer.from('"output_tokens":2}}'));
  assert.deepEqual(json.result(), { model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } });
  const junk = lib.createUsageReader('application/json');
  junk.feed(Buffer.from('<html>'));
  assert.equal(junk.result(), null);
});

const JAN_10 = new Date(2026, 0, 10, 12).getTime();
const FEB_2 = new Date(2026, 1, 2, 9).getTime();

test('budget: a monthly budget starts over in a new month, a total one keeps going', () => {
  const monthly = lib.addSpend(lib.withLimit(null, { limitUsd: 50, period: 'month' }, JAN_10), 12.5, JAN_10);
  assert.equal(monthly.spentUsd, 12.5);
  assert.equal(lib.currentBudget(monthly, FEB_2).spentUsd, 0);
  const total = lib.addSpend(lib.withLimit(null, { limitUsd: 50, period: 'total' }, JAN_10), 12.5, JAN_10);
  assert.equal(lib.currentBudget(total, FEB_2).spentUsd, 12.5);
  assert.equal(lib.resetSpend(total, FEB_2).spentUsd, 0);
});

test('budget: limit reached, no limit, and malformed files', () => {
  const b = lib.addSpend(lib.withLimit(null, { limitUsd: 10, period: 'total' }, JAN_10), 10, JAN_10);
  assert.equal(lib.isOverBudget(b, JAN_10), true);
  assert.equal(lib.isOverBudget(lib.withLimit(b, { limitUsd: 0 }, JAN_10), JAN_10), false);
  const broken = lib.normalizeBudget({ limitUsd: 'x', period: 'year', spentUsd: -4 }, JAN_10);
  assert.deepEqual([broken.limitUsd, broken.period, broken.spentUsd], [0, 'month', 0]);
  // Switching to monthly drops the total spent so far.
  assert.equal(lib.withLimit(b, { limitUsd: 10, period: 'month' }, JAN_10).spentUsd, 0);
});

test('budgetUsageView: a usage window with dollars; null without a limit', () => {
  assert.equal(lib.budgetUsageView(null, JAN_10), null);
  const b = lib.addSpend(lib.withLimit(null, { limitUsd: 50, period: 'month' }, JAN_10), 20, JAN_10);
  const [w] = lib.budgetUsageView(b, JAN_10).windows;
  assert.equal(w.key, 'budget');
  near(w.utilization, 0.4);
  assert.equal(w.resetAt, new Date(2026, 1, 1).getTime());
  assert.equal(w.resetIn, '22d');
  assert.deepEqual([w.spentUsd, w.limitUsd], [20, 50]);
  const over = lib.budgetUsageView(lib.addSpend(b, 100, JAN_10), JAN_10).windows[0];
  assert.equal(over.utilization, 1);
  const total = lib.budgetUsageView(lib.withLimit(b, { limitUsd: 50, period: 'total' }, JAN_10), JAN_10).windows[0];
  assert.deepEqual([total.resetAt, total.resetIn], [null, '']);
});

test('overBudgetError: the API error shape, naming the limit', () => {
  const e = lib.overBudgetError(50);
  assert.equal(e.error.type, 'invalid_request_error');
  assert.match(e.error.message, /\$50\.00/);
});
