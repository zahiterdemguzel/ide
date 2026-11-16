const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeTranscript, sumTranscriptTokens, resolveContextUsage, formatContext, sanitizeContextReport,
  formatTokens, formatCost, formatStatusLine,
} = require('../src/main/statusline-lib');

const line = (usage) => JSON.stringify({ type: 'assistant', message: { usage } });

test('sumTranscriptTokens: adds all four token classes across every assistant call', () => {
  const text = [
    line({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000 }),
    line({ input_tokens: 50, output_tokens: 10 }),
  ].join('\n');
  assert.equal(sumTranscriptTokens(text), 100 + 20 + 5 + 1000 + 50 + 10);
});

test('sumTranscriptTokens: ignores blank lines, non-JSON, and entries with no usage', () => {
  const text = [
    '',
    'not json at all',
    JSON.stringify({ type: 'user', message: { content: 'hi' } }), // no usage
    line({ input_tokens: 7, output_tokens: 3 }),
    '   ',
  ].join('\n');
  assert.equal(sumTranscriptTokens(text), 10);
});

test('sumTranscriptTokens: counts a response split across several lines only once', () => {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000 };
  const block = (id) => JSON.stringify({ type: 'assistant', message: { id, usage } });
  const text = [block('msg_a'), block('msg_a'), block('msg_a'), block('msg_b')].join('\n');
  assert.equal(sumTranscriptTokens(text), 2 * 1120);
});

test('sumTranscriptTokens: empty transcript -> 0', () => {
  assert.equal(sumTranscriptTokens(''), 0);
});

test('formatTokens: compacts by magnitude', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(12345), '12.3k');
  assert.equal(formatTokens(1000), '1k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatTokens(2000000), '2M');
});

test('formatCost: more precision while tiny, two decimals once over a dollar', () => {
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(-5), '$0.00');
  assert.equal(formatCost(0.0421), '$0.0421');
  assert.equal(formatCost(1.5), '$1.50');
});

test('formatStatusLine: joins model, then cost, then tokens with middots', () => {
  assert.equal(
    formatStatusLine({ model: 'Opus 4.8', tokens: 1234567, cost: 0.0421 }),
    'Opus 4.8 · $0.0421 · 1.23M tokens',
  );
});

test('formatStatusLine: omits the model when absent and defaults to zero', () => {
  assert.equal(formatStatusLine({}), '$0.00 · 0 tokens');
});

test('formatStatusLine: right-aligns the metrics to the given width, model on the left', () => {
  const out = formatStatusLine({ model: 'Opus 4.8', tokens: 1000, cost: 1.5, width: 40 });
  const metrics = '$1.50 · 1k tokens';
  assert.equal(out.length, 40);
  assert.ok(out.startsWith('Opus 4.8'));
  // cost sits left of the token count, which is what reaches the right edge
  assert.ok(out.endsWith(metrics));
  assert.ok(out.endsWith('1k tokens'));
  // padding lives between the two halves, not at the edges (survives trimming)
  assert.equal(out, 'Opus 4.8' + ' '.repeat(40 - 'Opus 4.8'.length - metrics.length) + metrics);
});

test('formatStatusLine: right-aligns metrics with no model (leading pad)', () => {
  const out = formatStatusLine({ tokens: 0, cost: 0, width: 20 });
  assert.equal(out.length, 20);
  assert.ok(out.endsWith('$0.00 · 0 tokens'));
});

test('formatStatusLine: margin reserves columns at the right edge', () => {
  const out = formatStatusLine({ model: 'M', tokens: 0, cost: 0, width: 30, margin: 4 });
  // line length is width - margin, leaving the reserved columns blank at the edge
  assert.equal(out.length, 26);
  assert.ok(out.endsWith('$0.00 · 0 tokens'));
});

test('formatStatusLine: falls back to inline when width is too small or invalid', () => {
  // width can't fit even one padding space -> inline join
  assert.equal(
    formatStatusLine({ model: 'M', tokens: 0, cost: 0, width: 5 }),
    'M · $0.00 · 0 tokens',
  );
  // NaN (unset $COLUMNS) -> inline join
  assert.equal(
    formatStatusLine({ model: 'M', tokens: 0, cost: 0, width: NaN }),
    'M · $0.00 · 0 tokens',
  );
});

// --- live context-window gauge ---

test('summarizeTranscript: last main-thread call is the current context, sidechains ignored', () => {
  const entry = (usage, extra = {}) => JSON.stringify({ type: 'assistant', message: { usage }, ...extra });
  const text = [
    entry({ input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 }),
    entry({ input_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 2000, output_tokens: 9 }),
    entry({ input_tokens: 99999 }, { isSidechain: true }),
  ].join('\n');
  const { totalTokens, lastContextTokens } = summarizeTranscript(text);
  assert.equal(lastContextTokens, 5 + 200 + 2000);
  assert.equal(totalTokens, 1060 + 2214 + 99999);
});

test('summarizeTranscript: no calls yet -> null context', () => {
  assert.equal(summarizeTranscript('').lastContextTokens, null);
});

test('resolveContextUsage: prefers Claude\'s stdin context_window and its percentage', () => {
  const ctx = resolveContextUsage({
    context_window_size: 200000,
    used_percentage: 42,
    current_usage: { input_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 80000, output_tokens: 500 },
  }, 1);
  assert.deepEqual(ctx, { usedTokens: 84000, windowSize: 200000, percent: 42 });
});

test('resolveContextUsage: computes the percentage when Claude omits it', () => {
  const ctx = resolveContextUsage({ context_window_size: 200000, current_usage: { input_tokens: 50000 } });
  assert.equal(ctx.percent, 25);
});

test('resolveContextUsage: falls back to the transcript count when stdin has no usage', () => {
  assert.deepEqual(resolveContextUsage({ context_window_size: 1000000, current_usage: null }, 250000),
    { usedTokens: 250000, windowSize: 1000000, percent: 25 });
  assert.deepEqual(resolveContextUsage(undefined, 1234), { usedTokens: 1234, windowSize: null, percent: null });
  assert.equal(resolveContextUsage(undefined, null), null);
});

test('formatContext: full, percent-only, tokens-only and empty forms', () => {
  assert.equal(formatContext({ usedTokens: 84000, windowSize: 200000, percent: 42.4 }), 'ctx 42% (84k/200k)');
  assert.equal(formatContext({ usedTokens: null, windowSize: null, percent: 7 }), 'ctx 7%');
  assert.equal(formatContext({ usedTokens: 1234, windowSize: null, percent: null }), 'ctx 1.2k');
  assert.equal(formatContext(null), '');
});

test('formatStatusLine: puts the context gauge beside the model on the left', () => {
  const context = { usedTokens: 84000, windowSize: 200000, percent: 42 };
  assert.equal(
    formatStatusLine({ model: 'Opus 5.5', tokens: 1000, cost: 1.5, context }),
    'Opus 5.5 · ctx 42% (84k/200k) · $1.50 · 1k tokens',
  );
  const out = formatStatusLine({ model: 'Opus 5.5', tokens: 1000, cost: 1.5, context, width: 60 });
  assert.equal(out.length, 60);
  assert.ok(out.startsWith('Opus 5.5 · ctx 42% (84k/200k)'));
  assert.ok(out.endsWith('$1.50 · 1k tokens'));
});

test('sanitizeContextReport: keeps finite non-negative numbers, drops the rest', () => {
  assert.deepEqual(sanitizeContextReport({ usedTokens: 84000, windowSize: 200000, percent: 42, extra: 'x' }),
    { usedTokens: 84000, windowSize: 200000, percent: 42 });
  assert.deepEqual(sanitizeContextReport({ usedTokens: '9', windowSize: -1, percent: 12 }),
    { usedTokens: null, windowSize: null, percent: 12 });
  assert.equal(sanitizeContextReport({ usedTokens: null, percent: NaN }), null);
  assert.equal(sanitizeContextReport('nope'), null);
});
