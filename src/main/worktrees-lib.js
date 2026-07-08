// Pure (Electron-free) naming rules for per-session git worktrees, plus the
// merge-conflict classifier the merge-back flow uses. Unit-tested in
// test/worktrees-lib.test.js; the git/fs glue lives in worktrees.js.

// A stable 8-char handle derived from the session UUID — short enough for a
// branch name, unique enough to never collide in practice.
function shortId(id) {
  return String(id || '').replace(/-/g, '').slice(0, 8) || 'session';
}

// The branch a worktree session works on. Namespaced under session/ so the
// branch selector groups them and they're recognizable in `git branch`.
function worktreeBranch(id) {
  return `session/${shortId(id)}`;
}

// The on-disk folder name for a session's worktree (under sharedDataDir/worktrees).
function worktreeDirName(id) {
  return `wt-${shortId(id)}`;
}

// Did a `git merge` fail because of CONFLICTS (hand it to a Claude session)
// rather than some other error (dirty tree, unknown branch — show the error)?
function mergeHasConflicts(output) {
  return /CONFLICT|Automatic merge failed/i.test(String(output || ''));
}

module.exports = { shortId, worktreeBranch, worktreeDirName, mergeHasConflicts };
