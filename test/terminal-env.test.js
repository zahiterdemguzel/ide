const { test } = require('node:test');
const assert = require('node:assert/strict');
const { terminalEnv, PTY_TERM_NAME } = require('../src/main/terminal-env');

test('terminalEnv: advertises a 256-color, truecolor xterm', () => {
  const out = terminalEnv({ TERM: 'xterm-color', LANG: 'en_US.UTF-8' }, 'darwin');
  assert.equal(PTY_TERM_NAME, 'xterm-256color');
  assert.equal(out.TERM, 'xterm-256color');
  assert.equal(out.COLORTERM, 'truecolor');
});

test('terminalEnv: drops the parent emulator identity so tools do not emit its private escapes', () => {
  const out = terminalEnv({ TERM_PROGRAM: 'iTerm.app', LC_TERMINAL: 'iTerm2', ITERM_SESSION_ID: 'x', LANG: 'C.UTF-8' }, 'darwin');
  assert.ok(!('TERM_PROGRAM' in out));
  assert.ok(!('LC_TERMINAL' in out));
  assert.ok(!('ITERM_SESSION_ID' in out));
});

test('terminalEnv: gives a Finder-launched app (no LANG) a UTF-8 locale', () => {
  assert.equal(terminalEnv({}, 'darwin').LANG, 'en_US.UTF-8');
});

test('terminalEnv: keeps a non-UTF-8 LANG for messages but forces UTF-8 encoding', () => {
  const out = terminalEnv({ LANG: 'C' }, 'linux');
  assert.equal(out.LANG, 'C');
  assert.equal(out.LC_CTYPE, 'en_US.UTF-8');
});

test('terminalEnv: leaves an existing UTF-8 locale and an explicit LC_ALL alone', () => {
  assert.deepEqual(terminalEnv({ LANG: 'tr_TR.UTF-8' }, 'darwin').LANG, 'tr_TR.UTF-8');
  assert.ok(!('LC_CTYPE' in terminalEnv({ LANG: 'tr_TR.UTF-8' }, 'darwin')));
  const pinned = terminalEnv({ LC_ALL: 'C' }, 'linux');
  assert.equal(pinned.LC_ALL, 'C');
  assert.ok(!('LANG' in pinned) && !('LC_CTYPE' in pinned));
});

test('terminalEnv: does not touch locales on Windows and does not mutate the input', () => {
  const input = { TERM_PROGRAM: 'vscode' };
  const out = terminalEnv(input, 'win32');
  assert.ok(!('LANG' in out));
  assert.equal(input.TERM_PROGRAM, 'vscode');
});
