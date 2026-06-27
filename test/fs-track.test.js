const { test } = require('node:test');
const assert = require('node:assert');
const { isBulkVcsCommand } = require('../src/main/fs-track');

test('bulk working-tree movers are detected', () => {
  for (const c of [
    'git pull',
    'git pull --ff-only',
    'git merge origin/main',
    'git rebase main',
    'git reset --hard HEAD~1',
    'git stash pop',
    'git cherry-pick abc123',
    'git revert HEAD',
    'git clone https://example.com/x.git',
    'git switch feature',
    'git checkout main',
    'git checkout -b new-feature',
    'git -C /repo pull',
    'git fetch && git merge origin/main', // compound: the merge half counts
  ]) {
    assert.equal(isBulkVcsCommand(c), true, c);
  }
});

test('path-level git edits and unrelated commands are NOT bulk movers', () => {
  for (const c of [
    'git mv old.txt new.txt',
    'git rm file.txt',
    'git add -A',
    'git commit -m "x"',
    'git status',
    'git diff',
    'git checkout -- src/file.js', // pathspec restore, a real working-tree edit
    'git checkout HEAD -- src/file.js',
    'npm install',
    'python build.py',
    'echo "git pull is in a string but not run"'.replace('git pull', 'gitpull'),
    '',
    null,
    undefined,
  ]) {
    assert.equal(isBulkVcsCommand(c), false, String(c));
  }
});
