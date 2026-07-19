const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedSessionCommand } = require('../src/main/session-cmd-parse');

test('detects a plainly-typed /model command on Enter', () => {
  assert.deepEqual(feedSessionCommand('', '/model opus\r'), { buf: '', model: 'opus', effort: null });
  assert.deepEqual(feedSessionCommand('', '/model sonnet\n'), { buf: '', model: 'sonnet', effort: null });
  assert.deepEqual(feedSessionCommand('', '/model default\r'), { buf: '', model: 'default', effort: null });
});

test('detects a plainly-typed /effort command on Enter', () => {
  assert.deepEqual(feedSessionCommand('', '/effort high\r'), { buf: '', model: null, effort: 'high' });
  assert.equal(feedSessionCommand('', '/effort xhigh\n').effort, 'xhigh');
  // `auto` is no longer a level, so it isn't tracked: the badge would have nothing to
  // show for it. The CLI still sees the keystrokes; only the badge declines to follow.
  assert.equal(feedSessionCommand('', '/effort auto\r').effort, null);
});

test('value is lowercased and surrounding whitespace tolerated', () => {
  assert.equal(feedSessionCommand('', '/model HAIKU\r').model, 'haiku');
  assert.equal(feedSessionCommand('', '  /model   fable  \r').model, 'fable');
  assert.equal(feedSessionCommand('', '  /effort   MAX  \r').effort, 'max');
});

test('accumulates across chunks (one keystroke at a time)', () => {
  let buf = '';
  for (const ch of '/effort medium') ({ buf } = feedSessionCommand(buf, ch));
  const out = feedSessionCommand(buf, '\r');
  assert.equal(out.effort, 'medium');
  assert.equal(out.buf, '');
});

test('backspace edits the line so a corrected command still matches', () => {
  // types "/model opuz", deletes the z, types "s", enters -> "/model opus"
  let buf = '';
  ({ buf } = feedSessionCommand(buf, '/model opuz'));
  ({ buf } = feedSessionCommand(buf, '\x7f'));
  ({ buf } = feedSessionCommand(buf, 's'));
  assert.equal(feedSessionCommand(buf, '\r').model, 'opus');
});

test('Ctrl-C / Ctrl-U clear the line', () => {
  assert.equal(feedSessionCommand('', '/model opus\x03').buf, '');
  assert.equal(feedSessionCommand('', '/model opus\x15').model, null);
  assert.equal(feedSessionCommand('', '/effort high\x03').effort, null);
});

test('ignores unrelated input and never false-positives on prose', () => {
  assert.deepEqual(feedSessionCommand('', 'switch to /model opus please\r'), { buf: '', model: null, effort: null });
  assert.deepEqual(feedSessionCommand('', 'raise the /effort high for this\r'), { buf: '', model: null, effort: null });
  assert.deepEqual(feedSessionCommand('', 'hello world\r'), { buf: '', model: null, effort: null });
});

test('an unknown value is not accepted', () => {
  assert.equal(feedSessionCommand('', '/model gpt\r').model, null);
  assert.equal(feedSessionCommand('', '/model\r').model, null); // no-arg picker form
  assert.equal(feedSessionCommand('', '/effort ultra\r').effort, null);
  assert.equal(feedSessionCommand('', '/effort\r').effort, null); // no-arg slider form
});

test('one line is one command: the two never fire together', () => {
  const out = feedSessionCommand('', '/model opus /effort high\r');
  assert.equal(out.model, null);
  assert.equal(out.effort, null);
});

test('a cursor-move escape sequence neither matches nor corrupts the buffer', () => {
  // "/model sonnet" then a Left-arrow (ESC [ D) then Enter still matches.
  let buf = '';
  ({ buf } = feedSessionCommand(buf, '/model sonnet'));
  ({ buf } = feedSessionCommand(buf, '\x1b[D'));
  assert.equal(feedSessionCommand(buf, '\r').model, 'sonnet');
});

test('CRLF does not double-evaluate', () => {
  const first = feedSessionCommand('', '/model opus\r');
  assert.equal(first.model, 'opus');
  assert.equal(feedSessionCommand(first.buf, '\n').model, null);
});
