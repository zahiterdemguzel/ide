const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trustKey, isFolderTrusted, withFolderTrusted } = require('../src/main/claude-trust-lib');

test('trustKey: POSIX paths are normalized without a trailing slash', () => {
  assert.equal(trustKey('/Users/me/repo/', 'darwin'), '/Users/me/repo');
  assert.equal(trustKey('/Users/me/./repo', 'linux'), '/Users/me/repo');
  assert.equal(trustKey('/', 'linux'), '/');
});

test('trustKey: Windows paths use forward slashes, like Claude Code does', () => {
  assert.equal(trustKey('C:\\Users\\me\\repo\\', 'win32'), 'C:/Users/me/repo');
});

test('isFolderTrusted: an exact entry or any trusted ancestor counts', () => {
  const config = { projects: { '/Users/me/repo': { hasTrustDialogAccepted: true } } };
  assert.ok(isFolderTrusted(config, '/Users/me/repo', 'darwin'));
  assert.ok(isFolderTrusted(config, '/Users/me/repo/.worktrees/a', 'darwin'));
  assert.ok(!isFolderTrusted(config, '/Users/me/other', 'darwin'));
  assert.ok(!isFolderTrusted(config, '/Users/me/repository', 'darwin'), 'a name prefix is not an ancestor');
});

test('isFolderTrusted: an explicit false is not trusted', () => {
  const config = { projects: { '/Users/me': { hasTrustDialogAccepted: false } } };
  assert.ok(!isFolderTrusted(config, '/Users/me/repo', 'darwin'));
  assert.ok(!isFolderTrusted({}, '/Users/me/repo', 'darwin'));
});

test('isFolderTrusted: a trusted Windows drive root covers the drive', () => {
  const config = { projects: { 'C:/': { hasTrustDialogAccepted: true } } };
  assert.ok(isFolderTrusted(config, 'C:\\work\\repo', 'win32'));
});

test('withFolderTrusted: adds the flag and keeps everything else', () => {
  const config = {
    numStartups: 3,
    projects: {
      '/Users/me/repo': { allowedTools: ['Bash'], hasTrustDialogAccepted: false },
      '/Users/me/other': { hasTrustDialogAccepted: true },
    },
  };
  const next = withFolderTrusted(config, '/Users/me/repo', 'darwin');
  assert.equal(next.numStartups, 3);
  assert.deepEqual(next.projects['/Users/me/repo'], { allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  assert.deepEqual(next.projects['/Users/me/other'], { hasTrustDialogAccepted: true });
  assert.equal(config.projects['/Users/me/repo'].hasTrustDialogAccepted, false, 'input is not mutated');
});

test('withFolderTrusted: creates the projects map when missing', () => {
  const next = withFolderTrusted({}, '/Users/me/repo', 'darwin');
  assert.deepEqual(next.projects, { '/Users/me/repo': { hasTrustDialogAccepted: true } });
});

test('withFolderTrusted: returns null when already trusted, so nothing is rewritten', () => {
  const config = { projects: { '/Users/me': { hasTrustDialogAccepted: true } } };
  assert.equal(withFolderTrusted(config, '/Users/me/repo', 'darwin'), null);
});
