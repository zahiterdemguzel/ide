const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');
const { git } = require('./git');
const { worktreeBranch, worktreeDirName } = require('./worktrees-lib');

// Per-session git worktrees (Settings → General → "Git worktree per session",
// default OFF). When enabled, each new session gets its own worktree + branch so
// parallel agents never touch each other's working tree; the naming rules are the
// pure worktrees-lib.js. Worktrees live under the shared data dir (not inside the
// repo) so they never show up in the explorer tree or the repo's own git status.

// The renderer pushes the saved toggle on startup and on change (same pattern as
// the statusline toggle); main defaults off until told otherwise.
let enabled = false;
function setEnabled(on) { enabled = !!on; }
function isEnabled() { return enabled; }

const worktreesDir = path.join(sharedDataDir, 'worktrees');

// Create the worktree (and its session/<id8> branch off the current HEAD) for a
// new session. Returns { workdir, branch } or null when it can't be created —
// a non-git folder, a repo with no commits yet, or any git failure — in which
// case the caller falls back to a normal shared-tree session.
async function createSessionWorktree(id, repo) {
  const inRepo = await git(['rev-parse', '--is-inside-work-tree'], { cwd: repo });
  if (!inRepo.ok || inRepo.stdout.trim() !== 'true') return null;
  try { fs.mkdirSync(worktreesDir, { recursive: true }); } catch { return null; }
  const workdir = path.join(worktreesDir, worktreeDirName(id));
  const r = await git(['worktree', 'add', '-b', worktreeBranch(id), workdir], { cwd: repo });
  if (!r.ok) {
    console.error('[worktree add failed]', r.stderr);
    return null;
  }
  return { workdir, branch: worktreeBranch(id) };
}

// Remove a session's worktree folder when the session is permanently deleted.
// The session/<id8> BRANCH is deliberately kept — it's the only remaining copy
// of any unmerged work, and a stale branch is cheap; the user can delete it from
// the branch selector.
async function removeSessionWorktree(s) {
  if (!s || !s.workdir || !s.repo) return;
  await git(['worktree', 'remove', '--force', s.workdir], { cwd: s.repo });
}

module.exports = { setEnabled, isEnabled, createSessionWorktree, removeSessionWorktree };
