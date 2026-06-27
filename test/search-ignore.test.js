const { test } = require('node:test');
const assert = require('node:assert/strict');
const { IGNORED_DIRS, shouldSkipDir, GREP_EXCLUDE_PATHSPECS } = require('../src/main/search-ignore');

test('shouldSkipDir: skips dependency/build dirs across ecosystems', () => {
  for (const name of ['node_modules', 'venv', '.venv', '__pycache__', 'target', 'dist', 'build', '.git']) {
    assert.equal(shouldSkipDir(name), true, `${name} should be skipped`);
  }
});

test('shouldSkipDir: does not skip ordinary source dirs', () => {
  for (const name of ['src', 'lib', 'app', 'docs', 'tests']) {
    assert.equal(shouldSkipDir(name), false, `${name} should NOT be skipped`);
  }
});

test('shouldSkipDir: skips un-named dot-dirs (tooling/cache state) by the catch-all', () => {
  for (const name of ['.terraform', '.docusaurus', '.angular', '.foo']) {
    assert.equal(shouldSkipDir(name), true, `${name} should be skipped by the dot catch-all`);
  }
});

test('shouldSkipDir: keeps allowlisted dot-dirs the user searches', () => {
  for (const name of ['.vscode', '.github']) {
    assert.equal(shouldSkipDir(name), false, `${name} should stay searchable`);
  }
});

test('shouldSkipDir: exact name match only (non-dot substrings are not skipped)', () => {
  assert.equal(shouldSkipDir('my-node_modules'), false);
  assert.equal(shouldSkipDir('distribution'), false);
});

test('GREP_EXCLUDE_PATHSPECS: one exclude pathspec per named dir, no positive pathspecs', () => {
  // Positive (non-exclude) pathspecs would flip git grep into "search only
  // these paths" mode and break references search, so there must be none.
  assert.equal(GREP_EXCLUDE_PATHSPECS.length, IGNORED_DIRS.size);
  assert.ok(GREP_EXCLUDE_PATHSPECS.includes(':(exclude,glob)**/node_modules/**'));
  assert.ok(GREP_EXCLUDE_PATHSPECS.every((p) => p.startsWith(':(exclude,glob)**/')));
});
