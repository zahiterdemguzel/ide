const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installGuide, installArgs, authArgs, INSTALL_OK, INSTALL_FAIL, DOCS_URL } = require('../src/main/claude-install');

test('installArgs: POSIX runs the shell installer in a login+interactive shell', () => {
  for (const p of ['darwin', 'linux']) {
    const a = installArgs(p);
    assert.deepEqual(a.slice(0, 1), ['-ilc'], 'spawns `$SHELL -ilc <cmd>` so the command is an argument, not typed');
    assert.match(a[1], /curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash/);
  }
});

test('installArgs: Windows runs the PowerShell installer and stays open', () => {
  const a = installArgs('win32');
  assert.ok(a.includes('-NoExit'));
  assert.ok(a.includes('-Command'));
  assert.match(a[a.length - 1], /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
});

test('installArgs: the command echoes OK on success and FAIL otherwise (never a false success)', () => {
  const posix = installArgs('linux')[1];
  // && on success → OK, || on failure → FAIL
  assert.match(posix, new RegExp(`&& echo ${INSTALL_OK}`));
  assert.match(posix, new RegExp(`\\|\\| echo ${INSTALL_FAIL}`));
  const win = installArgs('win32')[3];
  assert.match(win, new RegExp(`if \\(\\$\\?\\) \\{ echo ${INSTALL_OK} \\} else \\{ echo ${INSTALL_FAIL} \\}`));
});

test('authArgs: POSIX runs claude in a login+interactive shell (so PATH is fresh)', () => {
  assert.deepEqual(authArgs('darwin'), ['-ilc', 'claude']);
  assert.deepEqual(authArgs('linux'), ['-ilc', 'claude']);
});

test('authArgs: Windows refreshes PATH from the registry, then runs claude', () => {
  const a = authArgs('win32');
  const cmd = a[a.length - 1];
  assert.match(cmd, /GetEnvironmentVariable\('Path','User'\)/);
  assert.match(cmd, /GetEnvironmentVariable\('Path','Machine'\)/);
  assert.ok(cmd.trimEnd().endsWith('claude'));
});

test('installGuide: bundles the argv for each step, the markers, docs URL and run command', () => {
  const g = installGuide('darwin');
  assert.equal(g.platform, 'darwin');
  assert.deepEqual(g.installArgs, installArgs('darwin'));
  assert.deepEqual(g.authArgs, authArgs('darwin'));
  assert.equal(g.installOk, INSTALL_OK);
  assert.equal(g.installFail, INSTALL_FAIL);
  assert.equal(g.docsUrl, DOCS_URL);
  assert.equal(g.run, 'claude');
});

test('installGuide: defaults to the current platform', () => {
  assert.equal(installGuide().platform, process.platform);
});
