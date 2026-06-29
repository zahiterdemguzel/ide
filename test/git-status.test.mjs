import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, normalizeBranchName } from '../src/renderer/shared/git-status.js';

test('statusLabel: a staged vs unstaged deletion read differently', () => {
  // The whole point: the same "D" glyph in both columns must not describe the
  // same thing, so unstaging a deletion (which only moves it to the unstaged
  // list) is visibly not the same as it disappearing.
  assert.equal(statusLabel('D', true), 'Staged deletion');
  assert.equal(statusLabel('D', false),
    'Deleted on disk — not staged (use Discard to restore the file)');
});

test('statusLabel: an unstaged deletion points at Discard, not unstage', () => {
  assert.match(statusLabel('D', false), /Discard/);
});

test('statusLabel: common statuses spell out the column', () => {
  assert.equal(statusLabel('M', true), 'Staged modification');
  assert.equal(statusLabel('M', false), 'Unstaged modification');
  assert.equal(statusLabel('A', true), 'Staged new file');
  assert.equal(statusLabel('R', true), 'Staged rename');
});

test('statusLabel: untracked is always "not staged"', () => {
  assert.equal(statusLabel('?', false), 'Untracked — not staged');
});

test('statusLabel: an unknown status falls back to a quoted label', () => {
  assert.equal(statusLabel('X', true), 'Staged “X” change');
  assert.equal(statusLabel('X', false), 'Unstaged “X” change');
});

test('normalizeBranchName: spaces become hyphens', () => {
  assert.equal(normalizeBranchName('fix login bug'), 'fix-login-bug');
});

test('normalizeBranchName: runs of whitespace collapse to one hyphen and ends are trimmed', () => {
  assert.equal(normalizeBranchName('  feature   x  '), 'feature-x');
  assert.equal(normalizeBranchName('a\tb'), 'a-b');
});

test('normalizeBranchName: a name with no spaces is unchanged', () => {
  assert.equal(normalizeBranchName('feature/login'), 'feature/login');
});

test('normalizeBranchName: empty or whitespace-only is empty', () => {
  assert.equal(normalizeBranchName(''), '');
  assert.equal(normalizeBranchName('   '), '');
  assert.equal(normalizeBranchName(null), '');
});
