const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAsk, stripAnsi } = require('../src/main/tui-prompt');

// The permission box as the TUI actually paints it: colours, box glyphs, a pointer
// on the selected option, and a hint line underneath.
const PERMISSION = [
  '\x1b[2J\x1b[H',
  '\x1b[38;5;153m╭──────────────────────────────────────╮\x1b[39m',
  '\x1b[38;5;153m│\x1b[39m Edit file                            \x1b[38;5;153m│\x1b[39m',
  '\x1b[38;5;153m│\x1b[39m Do you want to make this edit to sessions.js? \x1b[38;5;153m│\x1b[39m',
  '\x1b[38;5;153m│\x1b[39m \x1b[36m❯ 1. Yes\x1b[39m                            \x1b[38;5;153m│\x1b[39m',
  "\x1b[38;5;153m│\x1b[39m   2. Yes, and don't ask again        \x1b[38;5;153m│\x1b[39m",
  '\x1b[38;5;153m│\x1b[39m   3. No, and tell Claude what to do differently \x1b[38;5;153m│\x1b[39m',
  '\x1b[38;5;153m╰──────────────────────────────────────╯\x1b[39m',
  '  esc to interrupt',
].join('\r\n');

test('parseAsk: lifts the question and its options out of the painted box', () => {
  const ask = parseAsk(PERMISSION);
  assert.equal(ask.question, 'Do you want to make this edit to sessions.js?');
  assert.deepEqual(ask.options, [
    { key: '1', label: 'Yes' },
    { key: '2', label: "Yes, and don't ask again" },
    { key: '3', label: 'No, and tell Claude what to do differently' },
  ]);
});

test('parseAsk: the box on screen is the last one painted, not the first', () => {
  const stale = PERMISSION.replace('sessions.js', 'old.js');
  const ask = parseAsk(stale + '\r\n' + PERMISSION);
  assert.equal(ask.question, 'Do you want to make this edit to sessions.js?');
});

test('parseAsk: a numbered list that is not a menu is not a question', () => {
  assert.equal(parseAsk('Here is the plan:\n1. one\n'), null, 'a single item is not a menu');
  assert.equal(parseAsk('output:\n2. two\n3. three\n'), null, 'a menu is numbered from 1');
  assert.equal(parseAsk('just some output\nno options at all\n'), null);
});

test('parseAsk: a question whose options it cannot read is still a question', () => {
  // Not every prompt is a menu ("Press enter to continue"); the caller shows the
  // question with a free-text reply rather than leaving the chat looking idle.
  assert.equal(parseAsk('╭───╮\n│ Continue? (y/n)\n╰───╯'), null);
});

test('parseAsk: falls back to a generic question when nothing above the options reads as one', () => {
  const ask = parseAsk('  esc to interrupt\n1. Yes\n2. No\n');
  assert.equal(ask.question, 'Claude needs your input');
  assert.equal(ask.options.length, 2);
});

test('stripAnsi: removes colour, cursor moves and OSC titles, keeping the text', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m \x1b[2A\x1b]0;title\x07text'), 'red text');
});
