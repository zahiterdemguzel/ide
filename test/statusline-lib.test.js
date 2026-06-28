const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  sumTranscriptTokens, formatTokens, formatCost, formatStatusLine,
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
