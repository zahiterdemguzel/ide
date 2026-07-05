const { test } = require('node:test');
const assert = require('node:assert/strict');
const { feedEffortInput } = require('../src/main/effort-parse');

test('detects a plainly-typed /effort command on Enter', () => {
  assert.deepEqual(feedEffortInput('', '/effort high\r'), { buf: '', effort: 'high' });
  assert.deepEqual(feedEffortInput('', '/effort auto\n'), { buf: '', effort: 'auto' });
  assert.deepEqual(feedEffortInput('', '/effort xhigh\r'), { buf: '', effort: 'xhigh' });
});

test('level is lowercased and surrounding whitespace tolerated', () => {
  assert.equal(feedEffortInput('', '/effort MAX\r').effort, 'max');
  assert.equal(feedEffortInput('', '  /effort   medium  \r').effort, 'medium');
});

test('accumulates across chunks (one keystroke at a time)', () => {
  let buf = '';
  for (const ch of '/effort low') ({ buf } = feedEffortInput(buf, ch));
  const out = feedEffortInput(buf, '\r');
  assert.equal(out.effort, 'low');
  assert.equal(out.buf, '');
});

test('backspace edits the line so a corrected command still matches', () => {
  // types "/effort loq", deletes the q, types "w", enters -> "/effort low"
  let buf = '';
  ({ buf } = feedEffortInput(buf, '/effort loq'));
  ({ buf } = feedEffortInput(buf, '\x7f'));
  ({ buf } = feedEffortInput(buf, 'w'));
  assert.equal(feedEffortInput(buf, '\r').effort, 'low');
});

test('Ctrl-C / Ctrl-U clear the line', () => {
  assert.equal(feedEffortInput('', '/effort high\x03').buf, '');
  assert.equal(feedEffortInput('', '/effort high\x15').effort, null);
});

test('ignores unrelated input and never false-positives on prose', () => {
  assert.deepEqual(feedEffortInput('', 'please use /effort high for this\r'), { buf: '', effort: null });
  assert.deepEqual(feedEffortInput('', 'hello world\r'), { buf: '', effort: null });
});

test('an unknown level is not accepted', () => {
  assert.equal(feedEffortInput('', '/effort turbo\r').effort, null);
  assert.equal(feedEffortInput('', '/effort\r').effort, null); // no-arg slider form
});

test('a cursor-move escape sequence neither matches nor corrupts the buffer', () => {
  // "/effort high" then a Left-arrow (ESC [ D) then Enter still matches.
  let buf = '';
  ({ buf } = feedEffortInput(buf, '/effort high'));
  ({ buf } = feedEffortInput(buf, '\x1b[D'));
  assert.equal(feedEffortInput(buf, '\r').effort, 'high');
});

test('CRLF does not double-evaluate', () => {
  const first = feedEffortInput('', '/effort max\r');
  assert.equal(first.effort, 'max');
  assert.equal(feedEffortInput(first.buf, '\n').effort, null);
});
