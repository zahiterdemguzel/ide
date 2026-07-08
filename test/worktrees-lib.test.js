const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shortId, worktreeBranch, worktreeDirName, mergeHasConflicts } = require('../src/main/worktrees-lib');

test('shortId: first 8 hex chars of the UUID, dashes stripped', () => {
  assert.equal(shortId('a1b2c3d4-e5f6-7890-abcd-ef0123456789'), 'a1b2c3d4');
});

test('shortId: falls back for an empty id', () => {
  assert.equal(shortId(''), 'session');
  assert.equal(shortId(null), 'session');
});

test('worktreeBranch / worktreeDirName: namespaced, stable per id', () => {
  const id = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
  assert.equal(worktreeBranch(id), 'session/a1b2c3d4');
  assert.equal(worktreeDirName(id), 'wt-a1b2c3d4');
});

test('mergeHasConflicts: matches git conflict output only', () => {
  assert.ok(mergeHasConflicts('CONFLICT (content): Merge conflict in a.js'));
  assert.ok(mergeHasConflicts('Automatic merge failed; fix conflicts and then commit the result.'));
  assert.ok(!mergeHasConflicts('error: Your local changes to the following files would be overwritten by merge'));
  assert.ok(!mergeHasConflicts('merge: session/abc - not something we can merge'));
  assert.ok(!mergeHasConflicts(''));
  assert.ok(!mergeHasConflicts(null));
});
