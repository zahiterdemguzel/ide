const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, installCommand, authCommand, INSTALL_DONE, DOCS_URL } = require('../src/main/claude-install');

test('installCommand: Windows uses the PowerShell installer', () => {
  assert.ok(installCommand('win32').startsWith('irm https://claude.ai/install.ps1 | iex'));
});

test('installCommand: macOS/Linux use the shell installer', () => {
  assert.ok(installCommand('darwin').startsWith('curl -fsSL https://claude.ai/install.sh | bash'));
  assert.ok(installCommand('linux').startsWith('curl -fsSL https://claude.ai/install.sh | bash'));
});

test('installCommand: appends a completion marker chained with ; (runs even on failure)', () => {
  const cmd = installCommand('linux');
  assert.match(cmd, /; echo /);
  // The printed token embeds a quote so the shell's echo of the typed command line
  // doesn't itself match the marker — only the real program output does.
  assert.ok(cmd.includes(`${INSTALL_DONE.slice(0, -'COMPLETE'.length)}"COMPLETE"`));
  assert.ok(!cmd.includes(`echo ${INSTALL_DONE}`), 'unquoted marker must not appear verbatim in the command');
});

test('authCommand: POSIX re-execs a login shell so PATH refreshes, then runs claude', () => {
  assert.equal(authCommand('linux'), 'exec "$SHELL" -ilc claude');
  assert.equal(authCommand('darwin'), 'exec "$SHELL" -ilc claude');
});

test('authCommand: Windows refreshes PATH from the registry, then runs claude', () => {
  const cmd = authCommand('win32');
  assert.match(cmd, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(cmd, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.ok(cmd.trimEnd().endsWith('claude'));
});

test('installGuide: bundles install, auth, marker, docs URL and run command', () => {
  const g = installGuide('darwin');
  assert.equal(g.platform, 'darwin');
  assert.equal(g.install, installCommand('darwin'));
  assert.equal(g.auth, authCommand('darwin'));
  assert.equal(g.installDone, INSTALL_DONE);
  assert.equal(g.docsUrl, DOCS_URL);
  assert.equal(g.run, 'claude');
});

test('installGuide: defaults to the current platform', () => {
  assert.equal(installGuide().platform, process.platform);
});
