const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, withAuth, NPM_PACKAGE, DOCS_URL } = require('../src/main/claude-install');

test('installGuide: Windows recommends the PowerShell installer, no npm', () => {
  const g = installGuide('win32');
  assert.equal(g.platform, 'win32');
  assert.equal(g.native.id, 'powershell');
  assert.equal(g.native.command, 'irm https://claude.ai/install.ps1 | iex');
  assert.equal(g.npm, null); // PowerShell installer works on a fresh Windows
});

test('installGuide: macOS recommends the shell installer, no npm', () => {
  const g = installGuide('darwin');
  assert.equal(g.native.id, 'shell');
  assert.equal(g.native.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(g.npm, null); // curl + bash ship by default
});

test('installGuide: Linux uses the shell installer and keeps the npm fallback', () => {
  const g = installGuide('linux');
  assert.equal(g.native.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.ok(g.npm, 'linux keeps npm (curl not guaranteed on minimal installs)');
  assert.equal(g.npm.command, `npm install -g ${NPM_PACKAGE}`);
  assert.equal(NPM_PACKAGE, '@anthropic-ai/claude-code');
});

test('withAuth: POSIX chains a login shell so PATH refreshes, then runs claude', () => {
  assert.equal(withAuth('linux', 'X'), 'X && exec "$SHELL" -ilc claude');
  assert.equal(withAuth('darwin', 'X'), 'X && exec "$SHELL" -ilc claude');
});

test('withAuth: Windows refreshes PATH from the registry, then runs claude', () => {
  const cmd = withAuth('win32', 'X');
  assert.ok(cmd.startsWith('X; '));
  assert.match(cmd, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(cmd, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.ok(cmd.trimEnd().endsWith('claude'));
});

test('installGuide: each option carries a terminalCommand that auto-launches claude', () => {
  const lin = installGuide('linux');
  assert.equal(lin.native.terminalCommand, withAuth('linux', lin.native.command));
  assert.equal(lin.npm.terminalCommand, withAuth('linux', lin.npm.command));
  const win = installGuide('win32');
  assert.equal(win.native.terminalCommand, withAuth('win32', win.native.command));
});

test('installGuide: carries the docs URL and the post-install run command', () => {
  const g = installGuide('darwin');
  assert.equal(g.docsUrl, DOCS_URL);
  assert.equal(g.run, 'claude');
});

test('installGuide: defaults to the current platform', () => {
  assert.equal(installGuide().platform, process.platform);
});
