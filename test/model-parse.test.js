const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedModelInput } = require('../src/main/model-parse');

test('detects a plainly-typed /model command on Enter', () => {
  assert.deepEqual(feedModelInput('', '/model opus\r'), { buf: '', model: 'opus' });
  assert.deepEqual(feedModelInput('', '/model sonnet\n'), { buf: '', model: 'sonnet' });
  assert.deepEqual(feedModelInput('', '/model default\r'), { buf: '', model: 'default' });
});

test('id is lowercased and surrounding whitespace tolerated', () => {
  assert.equal(feedModelInput('', '/model HAIKU\r').model, 'haiku');
  assert.equal(feedModelInput('', '  /model   fable  \r').model, 'fable');
});

test('accumulates across chunks (one keystroke at a time)', () => {
  let buf = '';
  for (const ch of '/model opus') ({ buf } = feedModelInput(buf, ch));
  const out = feedModelInput(buf, '\r');
  assert.equal(out.model, 'opus');
  assert.equal(out.buf, '');
});

test('backspace edits the line so a corrected command still matches', () => {
  // types "/model opuz", deletes the z, types "s", enters -> "/model opus"
  let buf = '';
  ({ buf } = feedModelInput(buf, '/model opuz'));
  ({ buf } = feedModelInput(buf, '\x7f'));
  ({ buf } = feedModelInput(buf, 's'));
  assert.equal(feedModelInput(buf, '\r').model, 'opus');
});

test('Ctrl-C / Ctrl-U clear the line', () => {
  assert.equal(feedModelInput('', '/model opus\x03').buf, '');
  assert.equal(feedModelInput('', '/model opus\x15').model, null);
});

test('ignores unrelated input and never false-positives on prose', () => {
  assert.deepEqual(feedModelInput('', 'switch to /model opus please\r'), { buf: '', model: null });
  assert.deepEqual(feedModelInput('', 'hello world\r'), { buf: '', model: null });
});

test('an unknown model is not accepted', () => {
  assert.equal(feedModelInput('', '/model gpt\r').model, null);
  assert.equal(feedModelInput('', '/model\r').model, null); // no-arg picker form
});

test('a cursor-move escape sequence neither matches nor corrupts the buffer', () => {
  // "/model sonnet" then a Left-arrow (ESC [ D) then Enter still matches.
  let buf = '';
  ({ buf } = feedModelInput(buf, '/model sonnet'));
  ({ buf } = feedModelInput(buf, '\x1b[D'));
  assert.equal(feedModelInput(buf, '\r').model, 'sonnet');
});

test('CRLF does not double-evaluate', () => {
  const first = feedModelInput('', '/model opus\r');
  assert.equal(first.model, 'opus');
  assert.equal(feedModelInput(first.buf, '\n').model, null);
});
