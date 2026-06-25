const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { getRepoPath } = require('./repo');
const { runHaiku } = require('./claude');

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

// Unmerged index states from `git status --porcelain` (both columns set).
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

async function gitStatus() {
  // --untracked-files=all: list each untracked file individually instead of
  // collapsing a wholly-untracked folder into one "assets/" entry (which the
  // pane can't open or stage per-file).
  const r = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (!r.ok) return { ok: false, error: r.stderr, staged: [], unstaged: [], conflicts: [] };
  const staged = [], unstaged = [], conflicts = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1]; // rename
    // Unmerged (conflicted) entries have both columns set in one of these pairs.
    // They must NOT go into staged/unstaged — the +/− actions there would be wrong
    // (and would list the file twice). Surface them separately so they're visible.
    if (CONFLICT.has(x + y)) { conflicts.push({ status: x + y, file }); continue; }
    if (x !== ' ' && x !== '?') staged.push({ status: x, file });
    if (y !== ' ') unstaged.push({ status: y === '?' ? '?' : y, file });
  }
  return { ok: true, staged, unstaged, conflicts, repo: getRepoPath(), ahead: await aheadCount(), branch: await currentBranch() };
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
  // ponytail: 12000-char cap keeps the prompt cheap; huge diffs are truncated.
  const prompt = 'Write a git commit message for the diff below: a concise '
    + 'imperative subject line, then an optional body. Reply with ONLY the '
    + 'message — no quotes, no code fences, no preamble.\n\n' + diff.slice(0, 12000);
  const out = await runHaiku(prompt, { cwd: getRepoPath() });
  return (out || '').slice(0, 1000);
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
  const r = await git(['push']);
  if (r.ok) return r;
  if (/no upstream|set-upstream|--set-upstream/i.test(r.stderr)) {
    return git(['push', '-u', 'origin', 'HEAD']);
  }
  return r;
});

// --- history (History tab) ---
// Recent commits for the History tab. Fields are unit-separator (\x1f) delimited,
// one commit per line — subjects never contain newlines, so splitting on \n is safe.
async function gitLog() {
  const fmt = ['%H', '%h', '%s', '%an', '%ar'].join('%x1f');
  const r = await git(['log', '-n', '100', '--pretty=format:' + fmt]);
  if (!r.ok) return { ok: false, error: r.stderr, commits: [] };
  const commits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const [hash, short, subject, author, relDate] = line.split('\x1f');
    commits.push({ hash, short, subject, author, relDate });
  }
  return { ok: true, commits };
}
ipcMain.handle('git-log', () => gitLog());

// Full patch of one commit, for the center diff viewer (--format= drops the
// commit metadata so only the unified diff comes back).
ipcMain.handle('git-commit-diff', (_e, hash) => git(['show', '--format=', hash]));

// Revert a commit: create a new commit that undoes it. Non-destructive — it does
// not rewrite history, so it's safe even on pushed commits.
ipcMain.handle('git-revert-commit', (_e, hash) => git(['revert', '--no-edit', hash]));
ipcMain.handle('git-fetch', () => git(['fetch']));
// Fast-forward only: a plain `git pull` that needs a merge would try to open an
// editor (no tty → hang) or leave conflicts. --ff-only fails cleanly when the
// branches diverged, and the user can hand the merge/conflict to a Claude session.
ipcMain.handle('git-pull', () => git(['pull', '--ff-only']));

module.exports = { git, gitStatus };
