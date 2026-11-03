// The phone Git tab's pure decisions (mobile/src/lib/git-actions.js): commit menus,
// toast wording from git/gh replies, branch-name massaging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBranchName, checkoutName, firstUrl, replyUrl, commitActionKeys,
  quickCommitAction, stashPushOutcome, syncSuccessMessage, prCreateMessage,
} from '../mobile/src/lib/git-actions.js';

test('normalizeBranchName hyphenates whitespace runs and trims', () => {
  assert.equal(normalizeBranchName('  fix  the bug '), 'fix-the-bug');
  assert.equal(normalizeBranchName(''), '');
  assert.equal(normalizeBranchName(undefined), '');
});

test('checkoutName strips the remote from a remote-only branch', () => {
  assert.equal(checkoutName({ name: 'origin/feat/x', remote: true }), 'feat/x');
  assert.equal(checkoutName({ name: 'feat/x', remote: false }), 'feat/x');
});

test('firstUrl finds the URL and drops trailing punctuation', () => {
  assert.equal(firstUrl('Opening https://github.com/o/r/pull/3 in your browser.'), 'https://github.com/o/r/pull/3');
  assert.equal(firstUrl('(see https://x.io/a).'), 'https://x.io/a');
  assert.equal(firstUrl('no link here'), '');
  assert.equal(firstUrl(undefined), '');
});

test('replyUrl prefers an explicit url, then stdout, then stderr', () => {
  assert.equal(replyUrl({ url: 'https://a', stdout: 'https://b' }), 'https://a');
  assert.equal(replyUrl({ stdout: 'https://b', stderr: 'https://c' }), 'https://b');
  assert.equal(replyUrl({ stderr: 'Opening https://c in your browser.' }), 'https://c');
  assert.equal(replyUrl(null), '');
});

test('commitActionKeys mirrors the desktop commit menu', () => {
  assert.deepEqual(commitActionKeys({ incoming: true }), ['view', 'cherry-pick', 'browse']);
  assert.deepEqual(
    commitActionKeys({ pushed: false }),
    ['view', 'branch', 'tag', 'browse', 'revert', 'undo', 'reset-soft', 'reset-hard'],
  );
  // A pushed commit can't be undone, only reverted.
  assert.ok(!commitActionKeys({ pushed: true }).includes('undo'));
  assert.ok(commitActionKeys({ pushed: true }).includes('revert'));
});

test('quickCommitAction: undo local, revert pushed, nothing incoming', () => {
  assert.equal(quickCommitAction({ pushed: false }), 'undo');
  assert.equal(quickCommitAction({ pushed: true }), 'revert');
  assert.equal(quickCommitAction({ incoming: true }), null);
});

test('stashPushOutcome reads "No local changes to save"', () => {
  assert.equal(stashPushOutcome({ ok: true, stdout: 'Saved working directory and index state WIP' }), 'stashed');
  assert.equal(stashPushOutcome({ ok: true, stdout: 'No local changes to save' }), 'nothing');
  assert.equal(stashPushOutcome({ ok: false, stderr: 'boom' }), 'failed');
  assert.equal(stashPushOutcome(undefined), 'failed');
});

test('syncSuccessMessage says when there was nothing to do', () => {
  assert.equal(syncSuccessMessage('pull', { stdout: 'Already up to date.' }), 'Already up to date');
  assert.equal(syncSuccessMessage('pull', { stdout: 'Fast-forward\n a | 1 +' }), 'Pulled');
  assert.equal(syncSuccessMessage('push', { stderr: 'Everything up-to-date' }), 'Nothing to push');
  assert.equal(syncSuccessMessage('push', { stderr: 'To github.com:o/r\n  a..b  main -> main' }), 'Pushed');
});

test('prCreateMessage distinguishes an existing PR', () => {
  assert.match(prCreateMessage({ ok: true, existing: true }), /already open/);
  assert.match(prCreateMessage({ ok: true }), /created/);
});
