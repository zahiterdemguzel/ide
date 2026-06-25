const { ipcMain } = require('electron');
const { execFile } = require('child_process');
const { getRepoPath } = require('./repo');

// --- git (plain porcelain, no dep) ---
// opts.env overrides env (e.g. GIT_INDEX_FILE for a throwaway index); opts.input
// is written to stdin (e.g. blob content for hash-object). 64M buffer for files.
function git(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd: getRepoPath(), env: opts.env || process.env, maxBuffer: 64 * 1024 * 1024 },
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
  if (!r.ok) return { ok: false, error: r.stderr, staged: [], unstaged: [] };
  const staged = [], unstaged = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1]; // rename
    if (x !== ' ' && x !== '?') staged.push({ status: x, file });
    if (y !== ' ') unstaged.push({ status: y === '?' ? '?' : y, file });
  }
  return { ok: true, staged, unstaged, repo: getRepoPath() };
}

ipcMain.handle('git-status', () => gitStatus());
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

// Commit staged changes. If nothing is staged, stage everything first so a bare
// Commit click behaves like "commit all" rather than failing with "nothing to commit".
ipcMain.handle('git-commit', async (_e, msg) => {
  const nothingStaged = (await git(['diff', '--cached', '--quiet'])).ok;
  if (nothingStaged) await git(['add', '-A']);
  return git(['commit', '-m', msg]);
});
// Undo last commit, keep its changes staged. ponytail: soft reset, no HEAD~1 history rewrite beyond one.
ipcMain.handle('git-undo', () => git(['reset', '--soft', 'HEAD~1']));
ipcMain.handle('git-push', () => git(['push']));

module.exports = { git, gitStatus };
