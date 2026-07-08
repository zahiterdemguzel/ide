const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectDirName, accumulateTranscript, totalTokens } = require('../src/main/usage-stats-lib');

test('projectDirName: every non-alphanumeric char becomes a dash', () => {
  assert.equal(projectDirName('C:\\Users\\zahit\\proj'), 'C--Users-zahit-proj');
  assert.equal(projectDirName('/home/u/my.app'), '-home-u-my-app');
  // Non-ASCII letters are munged too (Claude Code's own rule).
  assert.equal(projectDirName('Masaüstü'), 'Masa-st-');
  assert.equal(projectDirName(''), '');
});

const line = (model, usage, extra = {}) => JSON.stringify({
  type: 'assistant',
  requestId: extra.requestId,
  message: { id: extra.id, model, usage },
});

test('accumulateTranscript: sums the four token classes per model', () => {
  const acc = new Map();
  const seen = new Set();
  const text = [
    line('claude-opus-4-8', { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }, { id: 'm1', requestId: 'r1' }),
    line('claude-opus-4-8', { input_tokens: 1, output_tokens: 2 }, { id: 'm2', requestId: 'r2' }),
    line('claude-haiku-4-5', { input_tokens: 5, output_tokens: 5 }, { id: 'm3', requestId: 'r3' }),
    '{"type":"user","message":{"role":"user","content":"hi"}}', // no usage — skipped
    'not json at all', // skipped
  ].join('\n');
  accumulateTranscript(text, acc, seen);
  assert.deepEqual(acc.get('claude-opus-4-8'), { input: 11, output: 22, cacheWrite: 30, cacheRead: 40 });
  assert.deepEqual(acc.get('claude-haiku-4-5'), { input: 5, output: 5, cacheWrite: 0, cacheRead: 0 });
});

test('accumulateTranscript: dedupes by message.id + requestId across transcripts', () => {
  const acc = new Map();
  const seen = new Set();
  const dup = line('claude-opus-4-8', { input_tokens: 100, output_tokens: 1 }, { id: 'mX', requestId: 'rX' });
  accumulateTranscript(dup, acc, seen);
  accumulateTranscript(dup, acc, seen); // e.g. a resume rewrote the same entry
  assert.equal(acc.get('claude-opus-4-8').input, 100);
});

test('accumulateTranscript: entries with no ids are still counted', () => {
  const acc = new Map();
  const seen = new Set();
  const anon = line('claude-opus-4-8', { input_tokens: 1, output_tokens: 1 });
  accumulateTranscript(anon + '\n' + anon, acc, seen);
  assert.equal(acc.get('claude-opus-4-8').input, 2);
});

test('accumulateTranscript: skips synthetic model rows', () => {
  const acc = new Map();
  accumulateTranscript(line('<synthetic>', { input_tokens: 9, output_tokens: 9 }, { id: 's', requestId: 's' }), acc, new Set());
  assert.equal(acc.size, 0);
});

test('totalTokens: sums the bundle, tolerating missing classes', () => {
  assert.equal(totalTokens({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }), 10);
  assert.equal(totalTokens({ output: 7 }), 7);
});
