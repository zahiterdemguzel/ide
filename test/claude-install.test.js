const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, NPM_PACKAGE, DOCS_URL } = require('../src/main/claude-install');

test('installGuide: Windows recommends the PowerShell installer', () => {
  const g = installGuide('win32');
  assert.equal(g.platform, 'win32');
  assert.equal(g.native.id, 'powershell');
  assert.equal(g.native.command, 'irm https://claude.ai/install.ps1 | iex');
});

test('installGuide: macOS recommends the shell installer', () => {
  const g = installGuide('darwin');
  assert.equal(g.native.id, 'shell');
  assert.equal(g.native.command, 'curl -fsSL https://claude.ai/install.sh | bash');
});

test('installGuide: Linux (and other POSIX) use the shell installer', () => {
  assert.equal(installGuide('linux').native.command, 'curl -fsSL https://claude.ai/install.sh | bash');
  assert.equal(installGuide('freebsd').native.id, 'shell');
});

test('installGuide: npm fallback installs the official package', () => {
  const g = installGuide('linux');
  assert.equal(g.npm.id, 'npm');
  assert.equal(g.npm.command, `npm install -g ${NPM_PACKAGE}`);
  assert.equal(NPM_PACKAGE, '@anthropic-ai/claude-code');
});

test('installGuide: carries the docs URL and the post-install run command', () => {
  const g = installGuide('darwin');
  assert.equal(g.docsUrl, DOCS_URL);
  assert.equal(g.run, 'claude');
});

test('installGuide: defaults to the current platform', () => {
  assert.equal(installGuide().platform, process.platform);
});
