const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, DOCS_URL } = require('../src/main/claude-install');

test('installGuide: Windows uses the PowerShell installer', () => {
  const g = installGuide('win32');
  assert.equal(g.platform, 'win32');
  assert.equal(g.install, 'irm https://claude.ai/install.ps1 | iex');
});

test('installGuide: macOS/Linux use the shell installer', () => {
  assert.equal(installGuide('darwin').install, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installGuide('linux').install, 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('installTerminal: appends an explicit exit so the install shell terminates', () => {
  assert.equal(installGuide('darwin').installTerminal, 'curl -fsSL https://claude.ai/install.sh | bash; exit');
  assert.equal(installGuide('win32').installTerminal, 'irm https://claude.ai/install.ps1 | iex; exit');
});

test('auth: POSIX just runs claude (rc re-sources the new PATH)', () => {
  assert.equal(installGuide('linux').auth, 'claude');
  assert.equal(installGuide('darwin').auth, 'claude');
});

test('auth: Windows refreshes PATH from the registry, then runs claude', () => {
  const a = installGuide('win32').auth;
  assert.match(a, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(a, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.ok(a.trimEnd().endsWith('claude'));
});

test('installGuide: carries the docs URL and the bare run command', () => {
  const g = installGuide('darwin');
  assert.equal(g.docsUrl, DOCS_URL);
  assert.equal(g.run, 'claude');
});

test('installGuide: defaults to the current platform', () => {
  assert.equal(installGuide().platform, process.platform);
});
