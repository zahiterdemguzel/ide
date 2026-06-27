const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { getRepoPath } = require('./repo');
const { runHaiku } = require('./claude');
const { parsePorcelain, parseLog, markPushed, pullNeedsMerge, pushNeedsMerge } = require('./git-parse');
const { commitMessagePrompt, cleanCommitMessage } = require('./commit-msg');

// --- git (plain porcelain, no dep) ---
// opts.env overrides env (e.g. GIT_INDEX_FILE for a throwaway index); opts.input
// is written to stdin (e.g. blob content for hash-object). 64M buffer for files.
//
// core.quotePath=false: emit non-ASCII paths verbatim instead of C-quoting them
// (e.g. "\303\251.txt"), so the porcelain paths we parse round-trip back to add/diff.
// GIT_TERMINAL_PROMPT=0: a remote that wants credentials with no helper would
// otherwise block forever on a prompt we can't answer (no tty) — fail fast instead.
// timeout: backstop so a stuck network op (push/pull/fetch) can't wedge the UI.
function git(args, opts = {}) {
  return new Promise((resolve) => {
    const env = { ...(opts.env || process.env), GIT_TERMINAL_PROMPT: '0' };
    const child = execFile('git', ['-c', 'core.quotePath=false', ...args],
      { cwd: getRepoPath(), env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 120000 },
      // git often reports failures on stdout (e.g. "nothing to commit"), so fall
      // back to stdout before err.message — otherwise the UI shows a bare "Command failed".
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && (stdout.trim() || err.message)) || '' }));
    if (opts.input != null) child.stdin.end(opts.input);
  });
}

async function gitStatus() {
  // --untracked-files=all: list each untracked file individually instead of
  // collapsing a wholly-untracked folder into one "assets/" entry (which the
  // pane can't open or stage per-file).
  const r = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (!r.ok) return { ok: false, error: r.stderr, staged: [], unstaged: [], conflicts: [] };
  const { staged, unstaged, conflicts } = parsePorcelain(r.stdout);
  return { ok: true, staged, unstaged, conflicts, repo: getRepoPath(), ahead: await aheadCount(), behind: await behindCount(), branch: await currentBranch() };
}

// The checked-out branch's short name, or 'HEAD' when detached (no branch).
// Empty string when not in a repo / no commits yet.
async function currentBranch() {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

// Commits on HEAD not yet on its upstream. Returns 0 when there is no upstream
// (no remote-tracking branch) or HEAD has no commits yet, so the badge stays hidden.
async function aheadCount() {
  const r = await git(['rev-list', '--count', '@{u}..HEAD']);
  if (!r.ok) return 0;
  return parseInt(r.stdout.trim(), 10) || 0;
}

// Commits on the upstream not yet on HEAD — i.e. what a pull would bring in.
// Reflects the last fetch's view of the remote, mirroring aheadCount(); returns
// 0 when there is no upstream, so the pull badge stays hidden.
async function behindCount() {
  const r = await git(['rev-list', '--count', 'HEAD..@{u}']);
  if (!r.ok) return 0;
  return parseInt(r.stdout.trim(), 10) || 0;
}

ipcMain.handle('git-status', () => gitStatus());

// Local branches for the branch selector, most-recently-committed first (so the
// branches the user is likely switching to sit at the top of a long list). The
// current branch is flagged so the renderer can mark/skip it.
ipcMain.handle('git-branches', async () => {
  const r = await git(['for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)', 'refs/heads']);
  if (!r.ok) return { ok: false, error: r.stderr, branches: [], current: '' };
  const branches = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  return { ok: true, branches, current: await currentBranch() };
});

// Switch branches. Fails cleanly (reported to the renderer) when the worktree
// has changes that would be overwritten — git refuses rather than clobbering them.
ipcMain.handle('git-checkout', (_e, branch) => git(['checkout', branch]));

// Create a new branch off the current HEAD and switch to it. Git rejects names
// that break ref rules (spaces, '..', leading '-', etc.), reported to the renderer.
ipcMain.handle('git-create-branch', (_e, branch) => git(['checkout', '-b', branch]));
ipcMain.handle('git-stage', (_e, file) => git(['add', '--', file]));
ipcMain.handle('git-unstage', async (_e, file) => {
  const r = await git(['reset', '-q', 'HEAD', '--', file]);
  // ponytail: initial commit has no HEAD; fall back to removing from index
  if (!r.ok) return git(['rm', '--cached', '--', file]);
  return r;
});

// Untracked files have nothing to diff against, so compare to /dev/null
// (git-for-windows accepts it); exit code 1 just means "they differ".
ipcMain.handle('git-diff', (_e, { file, staged, untracked }) => {
  if (untracked) return git(['diff', '--no-index', '--', '/dev/null', file]);
  return git(['diff', ...(staged ? ['--cached'] : []), '--', file]);
});

// Discard a file's changes: delete it if untracked, else restore index+worktree to HEAD.
ipcMain.handle('git-revert', (_e, { file, untracked }) => {
  if (untracked) return git(['clean', '-fq', '--', file]);
  return git(['restore', '--staged', '--worktree', '--', file]);
});

// Ask Haiku for a commit message describing the staged diff. Returns '' on an
// empty diff and falls back to the message text on failure (handled by caller).
async function generateCommitMessage() {
  const diff = (await git(['diff', '--cached'])).stdout;
  if (!diff.trim()) return '';
  const out = await runHaiku(commitMessagePrompt(diff), { cwd: getRepoPath() });
  return cleanCommitMessage(out);
}

// Commit staged changes. If nothing is staged, stage everything first so a bare
// Commit click behaves like "commit all" rather than failing with "nothing to commit".
// An empty message triggers a one-shot Haiku call to author one from the staged diff.
ipcMain.handle('git-commit', async (_e, msg) => {
  const nothingStaged = (await git(['diff', '--cached', '--quiet'])).ok;
  if (nothingStaged) await git(['add', '-A']);
  if (!msg || !msg.trim()) {
    msg = await generateCommitMessage();
    if (!msg) return { ok: false, stderr: 'Could not generate a commit message' };
  }
  const r = await git(['commit', '-m', msg]);
  return { ...r, message: msg };
});
// Undo last commit, keep its changes staged. ponytail: soft reset, no HEAD~1 history rewrite beyond one.
ipcMain.handle('git-undo', () => git(['reset', '--soft', 'HEAD~1']));

// Push. A branch with no upstream fails with "has no upstream branch"; retry once
// with -u to create the tracking ref (the common first-push case) so the user
// doesn't have to drop to a terminal.
ipcMain.handle('git-push', async () => {
  let r = await git(['push']);
  if (!r.ok && /no upstream|set-upstream|--set-upstream/i.test(r.stderr)) {
    r = await git(['push', '-u', 'origin', 'HEAD']);
  }
  // A rejection because the remote moved on (someone pushed first) is fixable by a
  // pull/merge/push — flag it so the renderer can offer to hand that to a session.
  return { ...r, needsMerge: !r.ok && pushNeedsMerge(r.stderr) };
});

// --- history (History tab) ---
// Hashes of commits on HEAD not yet on the upstream — what the History tab tags as
// "unpushed" (and the push badge counts). With no upstream (no remote-tracking
// branch, or the rev-list otherwise fails) nothing has been pushed, so every listed
// commit counts as unpushed.
async function unpushedHashes(commits) {
  const r = await git(['rev-list', '@{u}..HEAD']);
  if (!r.ok) return commits.map((c) => c.hash);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Recent commits for the History tab. Fields are unit-separator (\x1f) delimited,
// one commit per line — subjects never contain newlines, so splitting on \n is safe.
// Each commit is tagged pushed/unpushed so the tab can show the split and pick the
// right "undo" action (history rewrite vs. revert commit).
async function gitLog() {
  const fmt = ['%H', '%h', '%s', '%an', '%ar'].join('%x1f');
  const r = await git(['log', '-n', '100', '--pretty=format:' + fmt]);
  if (!r.ok) return { ok: false, error: r.stderr, commits: [] };
  const commits = parseLog(r.stdout);
  return { ok: true, commits: markPushed(commits, await unpushedHashes(commits)) };
}
ipcMain.handle('git-log', () => gitLog());

// Full patch of one commit, for the center diff viewer (--format= drops the
// commit metadata so only the unified diff comes back).
ipcMain.handle('git-commit-diff', (_e, hash) => git(['show', '--format=', hash]));

// Revert a commit: create a new commit that undoes it. Non-destructive — it does
// not rewrite history, so it's the right tool for commits already pushed to the remote.
ipcMain.handle('git-revert-commit', (_e, hash) => git(['revert', '--no-edit', hash]));

// Undo an UNPUSHED commit by dropping it from history. Safe to rewrite since it
// isn't on the remote yet (the renderer only routes unpushed commits here). The
// HEAD commit is a soft reset so its changes stay staged — mirroring the Undo
// button; an older commit is excised by replaying everything after it onto its
// parent. If that rebase can't apply cleanly (the commit conflicts with a later
// one) we abort it so the worktree is left clean rather than mid-rebase.
ipcMain.handle('git-undo-commit', async (_e, hash) => {
  const head = await git(['rev-parse', 'HEAD']);
  if (head.ok && head.stdout.trim() === hash) return git(['reset', '--soft', hash + '^']);
  const r = await git(['rebase', '--onto', hash + '^', hash]);
  if (!r.ok) await git(['rebase', '--abort']);
  return r;
});
ipcMain.handle('git-fetch', () => git(['fetch']));
// Fast-forward only: a plain `git pull` that needs a merge would try to open an
// editor (no tty → hang) or leave conflicts. --ff-only fails cleanly when the
// branches diverged, and the user can hand the merge/conflict to a Claude session.
// On a divergence failure, flag `needsMerge` so the renderer can offer to hand the
// merge/conflict resolution to a Claude session instead of leaving the user stuck.
ipcMain.handle('git-pull', async () => {
  const r = await git(['pull', '--ff-only']);
  return { ...r, needsMerge: !r.ok && pullNeedsMerge(r.stderr) };
});

module.exports = { git, gitStatus };
