const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, installArgs, authArgs, INSTALL_OK, INSTALL_FAIL } = require('../src/main/codex-install');

test('posix install runs npm and echoes the OK/FAIL markers', () => {
  const args = installArgs('darwin');
  assert.equal(args[0], '-ilc');
  assert.match(args[1], /npm install -g @openai\/codex/);
  assert.match(args[1], new RegExp(INSTALL_OK));
  assert.match(args[1], new RegExp(INSTALL_FAIL));
});

test('windows install goes through powershell -Command', () => {
  const args = installArgs('win32');
  assert.deepEqual(args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command']);
  assert.match(args[3], /npm install -g @openai\/codex/);
});

test('auth runs codex login; windows refreshes PATH from the registry first', () => {
  assert.deepEqual(authArgs('linux'), ['-ilc', 'codex login']);
  const win = authArgs('win32');
  assert.match(win[3], /GetEnvironmentVariable\('User'\)|GetEnvironmentVariable\('Path','User'\)/);
  assert.match(win[3], /codex login$/);
});

test('the guide carries everything the wizard needs', () => {
  const g = installGuide('linux');
  assert.equal(g.run, 'codex');
  assert.ok(g.docsUrl.startsWith('https://'));
  assert.equal(g.installOk, INSTALL_OK);
  // Codex markers must never collide with the Claude wizard's.
  assert.notEqual(INSTALL_OK, 'CLAUDE_SETUP_INSTALL_OK');
});
