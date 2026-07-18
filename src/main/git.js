const bridge = require('./remote-bridge');
const { execFile } = require('child_process');
const { getRepoPath } = require('./repo');
const { runHaiku } = require('./claude');
const { parsePorcelain, parseLog, markPushed, markIncoming, filterCommits, pageCommits, parseStashList, pullNeedsMerge, pushNeedsMerge, parseBranches, orderBranchesByUsage, firstUrl } = require('./git-parse');
const { commitMessagePrompt, cleanCommitMessage } = require('./commit-msg');
const { validateRepoName, ghCreateArgs } = require('./repo-create');

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
    // No folder open yet: never let execFile default to the app's own cwd.
    if (!getRepoPath()) return resolve({ ok: false, stdout: '', stderr: 'no folder open' });
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

// Is the open folder inside a git work tree? Drives the git pane's two modes:
// the normal stage/commit view vs. the "create repository" panel shown for a
// plain (non-git) folder. `--is-inside-work-tree` prints "true" when it is.
async function isRepo() {
  const r = await git(['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}
bridge.handle('git-is-repo', () => isRepo());

bridge.handle('git-status', () => gitStatus());

// Run the GitHub CLI in the open folder. Mirrors git(): never rejects, returns
// { ok, stdout, stderr }. A missing `gh` (ENOENT) is reported as a clear,
// actionable message rather than a bare spawn error.
function gh(args) {
  return new Promise((resolve) => {
    if (!getRepoPath()) return resolve({ ok: false, stdout: '', stderr: 'no folder open' });
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('gh', args, { cwd: getRepoPath(), env, maxBuffer: 16 * 1024 * 1024, timeout: 120000 },
      (err, stdout, stderr) => {
        const enoent = err && err.code === 'ENOENT';
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: enoent
            ? 'GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com and run `gh auth login`.'
            : (stderr || (err && (stdout.trim() || err.message)) || ''),
        });
      });
  });
}

// Turn a plain folder into a git repo, make the initial commit, then create the
// GitHub repository and push — the whole flow behind the create-repo panel's one
// button. Default branch is `main` (set via symbolic-ref so it's honoured on git
// versions predating `init -b`). Returns { ok, step, error } so the renderer can
// say which stage failed.
async function createRepo({ name, description, isPrivate } = {}) {
  const valid = validateRepoName(name);
  if (!valid.ok) return { ok: false, step: 'name', error: valid.error };

  if (!(await isRepo())) {
    const init = await git(['init']);
    if (!init.ok) return { ok: false, step: 'init', error: init.stderr || 'git init failed' };
    await git(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }

  await git(['add', '-A']);
  let commit = await git(['commit', '-m', 'Initial commit']);
  // An empty folder has nothing to commit; still seed the repo with one commit so
  // the push has something to send and `main` exists on the remote.
  if (!commit.ok && /nothing to commit/i.test(commit.stdout + commit.stderr)) {
    commit = await git(['commit', '--allow-empty', '-m', 'Initial commit']);
  }
  if (!commit.ok) return { ok: false, step: 'commit', error: commit.stderr || 'Commit failed' };

  const created = await gh(ghCreateArgs({ name: valid.name, description, isPrivate }));
  if (!created.ok) return { ok: false, step: 'github', error: created.stderr || 'GitHub repository creation failed' };
  return { ok: true };
}
bridge.handle('create-repo', (_e, opts) => createRepo(opts));

// Branches for the branch selector. Both local (refs/heads) and remote-tracking
// (refs/remotes) branches are returned so the search covers everything;
// parseBranches drops remotes that duplicate a local name and the `origin/HEAD`
// pointer. The for-each-ref `--sort=-committerdate` gives a latest-*edited* order,
// then orderBranchesByUsage re-ranks by latest-*used* (last checkout) from the
// HEAD reflog — so with an empty search the branches the user is most likely to
// switch to sit at the top. The current branch is flagged so the renderer can
// mark/skip it.
bridge.handle('git-branches', async () => {
  const local = await git(['for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)', 'refs/heads']);
  if (!local.ok) return { ok: false, error: local.stderr, branches: [], current: '' };
  const remote = await git(['for-each-ref', '--sort=-committerdate',
    '--format=%(refname:short)', 'refs/remotes']);
  const reflog = await git(['reflog', '--pretty=%gs']);
  let branches = parseBranches(local.stdout, remote.ok ? remote.stdout : '');
  if (reflog.ok) branches = orderBranchesByUsage(branches, reflog.stdout);
  return { ok: true, branches, current: await currentBranch() };
});

// Switch branches. Fails cleanly (reported to the renderer) when the worktree
// has changes that would be overwritten — git refuses rather than clobbering them.
bridge.handle('git-checkout', (_e, branch) => git(['checkout', branch]));

// Create a new branch off the current HEAD and switch to it. Git rejects names
// that break ref rules (spaces, '..', leading '-', etc.), reported to the renderer.
bridge.handle('git-create-branch', (_e, branch) => git(['checkout', '-b', branch]));

// Delete a local branch. Force (`-D`) rather than `-d` because the renderer
// already gates this behind a two-click confirm — the guard is the approval,
// not git's merged-only check, so the button reliably removes the branch the
// user approved (git still refuses to delete the branch that's checked out).
bridge.handle('git-delete-branch', (_e, branch) => git(['branch', '-D', branch]));
bridge.handle('git-stage', (_e, file) => git(['add', '--', file]));
bridge.handle('git-unstage', async (_e, file) => {
  const r = await git(['reset', '-q', 'HEAD', '--', file]);
  // ponytail: initial commit has no HEAD; fall back to removing from index
  if (!r.ok) return git(['rm', '--cached', '--', file]);
  return r;
});

// Untracked files have nothing to diff against, so compare to /dev/null
// (git-for-windows accepts it); exit code 1 just means "they differ".
bridge.handle('git-diff', (_e, { file, staged, untracked }) => {
  if (untracked) return git(['diff', '--no-index', '--', '/dev/null', file]);
  return git(['diff', ...(staged ? ['--cached'] : []), '--', file]);
});

// Discard a file's changes: delete it if untracked, else restore index+worktree to HEAD.
bridge.handle('git-revert', (_e, { file, untracked }) => {
  if (untracked) return git(['clean', '-fq', '--', file]);
  return git(['restore', '--staged', '--worktree', '--', file]);
});

// Ask Haiku for a commit message describing the staged diff. Returns '' on an
// empty diff and falls back to the message text on failure (handled by caller).
async function generateCommitMessage() {
  const diff = (await git(['diff', '--cached'])).stdout;
  if (!diff.trim()) return '';
  const out = await runHaiku(commitMessagePrompt(diff));
  return cleanCommitMessage(out);
}

// Commit staged changes. If nothing is staged, stage everything first so a bare
// Commit click behaves like "commit all" rather than failing with "nothing to commit".
// An empty message triggers a one-shot Haiku call to author one from the staged diff.
bridge.handle('git-commit', async (_e, msg) => {
  const nothingStaged = (await git(['diff', '--cached', '--quiet'])).ok;
  if (nothingStaged) await git(['add', '-A']);
  if (!msg || !msg.trim()) {
    msg = await generateCommitMessage();
    if (!msg) return { ok: false, stderr: 'Could not generate a commit message' };
  }
  const r = await git(['commit', '-m', msg]);
  return { ...r, message: msg };
});
// Is HEAD already on the upstream? Rewriting such a commit (undo, amend) would
// diverge from the remote. With no upstream the rev-list fails, and nothing is
// pushed, so the rewrite is allowed.
async function headIsPushed() {
  const r = await git(['rev-list', '--count', '@{u}..HEAD']);
  return r.ok && (parseInt(r.stdout.trim(), 10) || 0) === 0;
}

// Undo last commit, keep its changes staged. Soft reset, no history rewrite beyond
// one. Pushed commits must be reverted (a new commit) instead.
bridge.handle('git-undo', async () => {
  if (await headIsPushed()) {
    return { ok: false, stderr: 'Last commit is already pushed — revert it instead of undoing.' };
  }
  return git(['reset', '--soft', 'HEAD~1']);
});

// Fold the current changes into the last commit. Mirrors git-commit: with nothing
// staged, stage everything first, so "amend" means "and everything I've since
// changed" rather than failing. An empty message keeps the original one
// (--no-edit — there is no tty to open an editor on). Refuses on a pushed commit
// for the same reason undo does: amending rewrites it.
bridge.handle('git-amend', async (_e, msg) => {
  if (await headIsPushed()) {
    return { ok: false, stderr: 'Last commit is already pushed — amending it would rewrite remote history.' };
  }
  const nothingStaged = (await git(['diff', '--cached', '--quiet'])).ok;
  if (nothingStaged) await git(['add', '-A']);
  const text = (msg || '').trim();
  return git(['commit', '--amend', ...(text ? ['-m', text] : ['--no-edit'])]);
});

// Push. A branch with no upstream fails with "has no upstream branch"; retry once
// with -u to create the tracking ref (the common first-push case) so the user
// doesn't have to drop to a terminal.
bridge.handle('git-push', async () => {
  let r = await git(['push']);
  if (!r.ok && /no upstream|set-upstream|--set-upstream/i.test(r.stderr)) {
    r = await git(['push', '-u', 'origin', 'HEAD']);
  }
  // A rejection because the remote moved on (someone pushed first) is fixable by a
  // pull/merge/push — flag it so the renderer can offer to hand that to a session.
  return { ...r, needsMerge: !r.ok && pushNeedsMerge(r.stderr) };
});

// Overwrite the remote branch with the local one — what a rewritten history (undo,
// amend, rebase) needs to publish. --force-with-lease, never a bare --force: it
// refuses if the remote moved since our last fetch, so a colleague's push can't be
// silently destroyed. The renderer confirms before calling this.
bridge.handle('git-force-push', async () => {
  let r = await git(['push', '--force-with-lease']);
  if (!r.ok && /no upstream|set-upstream|--set-upstream/i.test(r.stderr)) {
    r = await git(['push', '--force-with-lease', '-u', 'origin', 'HEAD']);
  }
  return r;
});

// Delete untracked files and folders. Ignored files (build output, node_modules)
// are deliberately left alone — no -x — so this cleans up stray new files without
// wiping the working setup. Destructive and unrecoverable; the renderer confirms.
bridge.handle('git-clean-untracked', () => git(['clean', '-fdq']));

// Open a pull request for the current branch. gh can only do that once the branch
// exists on the remote, so push it (with -u, creating the tracking ref) first.
// An already-open PR is surfaced as-is rather than failing on gh's "already
// exists". Either way the PR is opened in the browser — gh does that itself, as
// there is no openExternal path from main.
bridge.handle('gh-pr-create', async () => {
  const existing = await gh(['pr', 'view', '--json', 'url', '--jq', '.url']);
  if (existing.ok && existing.stdout.trim()) {
    await gh(['pr', 'view', '--web']);
    return { ok: true, existing: true, url: existing.stdout.trim() };
  }
  const push = await git(['push', '-u', 'origin', 'HEAD']);
  if (!push.ok) return { ok: false, stderr: push.stderr || 'Could not push the branch' };
  const created = await gh(['pr', 'create', '--fill']);
  if (!created.ok) return { ok: false, stderr: created.stderr || 'Could not create the pull request' };
  await gh(['pr', 'view', '--web']);
  return { ok: true, url: firstUrl(created.stdout) };
});

// Open the current branch's pull request / the repository on GitHub. Both are pure
// browser hand-offs; gh reports cleanly when there is no PR or no GitHub remote.
bridge.handle('gh-pr-view', () => gh(['pr', 'view', '--web']));
bridge.handle('gh-browse', () => gh(['browse']));

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

// Commits on the upstream not yet on HEAD — what a pull would bring in. Same
// fields/format as gitLog so the History tab can render them with the regular
// commit row (tagged `incoming`). Newest first, capped at 100. Empty when there is
// no upstream, nothing is incoming, or the rev-list fails. Reflects the last
// fetch's view of the remote, mirroring behindCount(); the fetched objects are
// local, so the diff viewer can already `git show` each one before pulling.
async function incomingCommits() {
  const fmt = ['%H', '%h', '%s', '%an', '%ar'].join('%x1f');
  const r = await git(['log', '-n', '100', '--pretty=format:' + fmt, 'HEAD..@{u}']);
  if (!r.ok) return [];
  return markIncoming(parseLog(r.stdout));
}

// Fields are unit-separator (\x1f) delimited, one commit per line - subjects never
// contain newlines, so splitting on \n is safe.
const LOG_FORMAT = ['%H', '%h', '%s', '%an', '%ar'].join('%x1f');
// How many commits one `git log` reads while hunting for search matches. Only used
// when there's a query; browsing pages straight out of git with --skip.
const SCAN_CHUNK = 2000;

// One page of the log.
//
// Browsing (no query) pages directly out of git with -n/--skip, so the cost is the
// page, not the history. Searching can't do that: the query matches author and hash
// as well as the subject, which `git log --grep` cannot express. So we read the log
// in chunks and filter each with filterCommits - the same matcher, and the same
// semantics, the desktop History tab uses. The scan stops as soon as the page is
// full, so a query hitting recent commits costs one chunk however long the history
// is; only a rare or unmatched query walks back far.
//
// Both paths ask git for one commit beyond the page, so `hasMore` is free.
async function logPage({ limit, skip, query }) {
  const q = (query || '').trim();
  if (!q) {
    // git applied the skip, so the page starts at 0 here; the +1 is what tells us
    // whether anything follows it.
    const r = await git(['log', '-n', String(limit + 1), '--skip=' + skip, '--pretty=format:' + LOG_FORMAT]);
    if (!r.ok) return { ok: false, error: r.stderr, commits: [], hasMore: false };
    return { ok: true, ...pageCommits(parseLog(r.stdout), 0, limit) };
  }
  const need = skip + limit + 1;
  const matches = [];
  for (let scanned = 0; matches.length < need; scanned += SCAN_CHUNK) {
    const r = await git(['log', '-n', String(SCAN_CHUNK), '--skip=' + scanned, '--pretty=format:' + LOG_FORMAT]);
    if (!r.ok) return { ok: false, error: r.stderr, commits: [], hasMore: false };
    const batch = parseLog(r.stdout);
    matches.push(...filterCommits(batch, q));
    if (batch.length < SCAN_CHUNK) break; // end of history
  }
  return { ok: true, ...pageCommits(matches, skip, limit) };
}

// Commits for the History views. Each local commit is tagged pushed/unpushed so the
// caller can show the split and pick the right "undo" action (history rewrite vs.
// revert commit).
//
// `incoming` (the not-yet-pulled commits previewed above the local log) rides along
// only on an unfiltered first page: it belongs at the top of the history, so repeating
// it per page would duplicate rows, and a search asks about local history, not about
// what a pull would bring in.
//
// The desktop calls this with no args (window.api.gitLog()), so the defaults reproduce
// its original behavior exactly: the newest 100 commits, plus incoming.
async function gitLog({ limit = 100, skip = 0, query = '' } = {}) {
  const page = await logPage({ limit, skip, query });
  if (!page.ok) return { ok: false, error: page.error, commits: [], incoming: [], hasMore: false };
  const firstPage = skip === 0 && !(query || '').trim();
  return {
    ok: true,
    commits: markPushed(page.commits, await unpushedHashes(page.commits)),
    incoming: firstPage ? await incomingCommits() : [],
    hasMore: page.hasMore,
  };
}
bridge.handle('git-log', (_e, opts) => gitLog(opts));

// Full patch of one commit, for the center diff viewer (--format= drops the
// commit metadata so only the unified diff comes back).
bridge.handle('git-commit-diff', (_e, hash) => git(['show', '--format=', hash]));

// Revert a commit: create a new commit that undoes it. Non-destructive — it does
// not rewrite history, so it's the right tool for commits already pushed to the remote.
bridge.handle('git-revert-commit', (_e, hash) => git(['revert', '--no-edit', hash]));

// Undo an UNPUSHED commit by dropping it from history. Safe to rewrite since it
// isn't on the remote yet (the renderer only routes unpushed commits here). The
// HEAD commit is a soft reset so its changes stay staged — mirroring the Undo
// button; an older commit is excised by replaying everything after it onto its
// parent. If that rebase can't apply cleanly (the commit conflicts with a later
// one) we abort it so the worktree is left clean rather than mid-rebase.
bridge.handle('git-undo-commit', async (_e, hash) => {
  const head = await git(['rev-parse', 'HEAD']);
  if (head.ok && head.stdout.trim() === hash) return git(['reset', '--soft', hash + '^']);
  const r = await git(['rebase', '--onto', hash + '^', hash]);
  if (!r.ok) await git(['rebase', '--abort']);
  return r;
});
// --- stash ---
// List stashes for the Stashes section. The selector (stash@{N}) is needed to
// apply/pop/drop a specific one; the message + relative date fill the row.
bridge.handle('git-stash-list', async () => {
  const r = await git(['stash', 'list', '--pretty=format:%gd%x1f%s%x1f%cr']);
  if (!r.ok) return { ok: false, error: r.stderr, stashes: [] };
  return { ok: true, stashes: parseStashList(r.stdout) };
});

// Stash the whole working tree so the user can set the changes aside.
// --include-untracked saves new files too (the "put everything away" intent).
// With nothing to stash, git exits 0 with "No local changes to save" — the
// renderer reads that to report it rather than a misleading "stashed".
bridge.handle('git-stash-push', () => git(['stash', 'push', '--include-untracked']));

// One stash's full patch for the center diff viewer (-p; no color/metadata noise).
bridge.handle('git-stash-show', (_e, ref) => git(['stash', 'show', '-p', ref]));

// Apply a stash and keep it (apply) or apply then delete it (pop). Either can
// conflict if the working tree moved on; git reports it and the renderer surfaces it.
bridge.handle('git-stash-apply', (_e, ref) => git(['stash', 'apply', ref]));
bridge.handle('git-stash-pop', (_e, ref) => git(['stash', 'pop', ref]));
// Delete a stash without applying it (two-click armed in the UI — it's destructive).
bridge.handle('git-stash-drop', (_e, ref) => git(['stash', 'drop', ref]));

bridge.handle('git-fetch', () => git(['fetch']));
// Fast-forward only: a plain `git pull` that needs a merge would try to open an
// editor (no tty â†’ hang) or leave conflicts. --ff-only fails cleanly when the
// branches diverged, and the user can hand the merge/conflict to a Claude session.
// On a divergence failure, flag `needsMerge` so the renderer can offer to hand the
// merge/conflict resolution to a Claude session instead of leaving the user stuck.
bridge.handle('git-pull', async () => {
  const r = await git(['pull', '--ff-only']);
  return { ...r, needsMerge: !r.ok && pullNeedsMerge(r.stderr) };
});

module.exports = { git, gitStatus, isRepo };
