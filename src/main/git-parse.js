// Pure parsers for git's machine-readable output. No electron, no subprocess —
// git.js runs the commands and feeds their stdout here, so the parsing (the part
// with the fiddly edge cases: rename arrows, unmerged states, field splitting)
// is unit-testable on its own.

// Unmerged index states from `git status --porcelain` (both columns set).
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// Parse `git status --porcelain=v1 --untracked-files=all` stdout into staged,
// unstaged, and conflicts lists. Unmerged (conflicted) entries have both columns
// set in one of the CONFLICT pairs; they must NOT go into staged/unstaged — the
// +/- actions there would be wrong (and would list the file twice) — so they're
// surfaced separately. For a rename ("R  old -> new") the new path is what we
// stage/diff against.
function parsePorcelain(stdout) {
  const staged = [], unstaged = [], conflicts = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1]; // rename
    if (CONFLICT.has(x + y)) { conflicts.push({ status: x + y, file }); continue; }
    if (x !== ' ' && x !== '?') staged.push({ status: x, file });
    if (y !== ' ') unstaged.push({ status: y === '?' ? '?' : y, file });
  }
  return { staged, unstaged, conflicts };
}

// Parse `git log --pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%ar` stdout. Fields are
// unit-separator (\x1f) delimited, one commit per line — subjects never contain
// newlines, so splitting on \n is safe.
function parseLog(stdout) {
  const commits = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [hash, short, subject, author, relDate] = line.split('\x1f');
    commits.push({ hash, short, subject, author, relDate });
  }
  return commits;
}

// Tag each parsed commit with `pushed`: false when its hash is in the unpushed
// set (commits on HEAD not yet on the upstream), true otherwise. The set comes
// from `git rev-list @{u}..HEAD`; with no upstream the caller passes every listed
// hash, so all local commits read as unpushed. Lets the History tab show — and
// act on — the pushed/unpushed split: unpushed commits can be safely undone
// (history rewrite), pushed ones must be reverted (a new undo commit).
function markPushed(commits, unpushedHashes) {
  const unpushed = new Set(unpushedHashes);
  return commits.map((c) => ({ ...c, pushed: !unpushed.has(c.hash) }));
}

// Tag each parsed commit with `incoming: true`. These are commits on the upstream
// that HEAD doesn't have yet — what a pull would bring in (`git log HEAD..@{u}`).
// The History tab renders them distinctly (download icon + accent stripe) above the
// local log so the user can preview what Sync will pull before pulling. Pure mirror
// of markPushed: it never mutates the input commits.
function markIncoming(commits) {
  return commits.map((c) => ({ ...c, incoming: true }));
}

// Filter parsed commits by a free-text query, matching across subject, author,
// and hash (full or short). Whitespace splits the query into terms that must ALL
// match (in any field), so "fix ada" finds Ada's fix commits. Case-insensitive;
// an empty/blank query returns the list unchanged.
function filterCommits(commits, query) {
  const terms = (query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return commits;
  return commits.filter((c) => {
    const hay = `${c.subject} ${c.author} ${c.hash} ${c.short}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

// Slice one page of commits out of a list, reporting whether any remain beyond it.
// Callers over-fetch by at least one commit past the page's end, so `hasMore` costs
// no extra git call: browsing asks git for limit+1 (and git already applied the skip,
// so it passes skip 0 here); searching keeps scanning until it holds skip+limit+1
// matches, or the history runs out. A short list simply yields a short page and
// hasMore:false.
function pageCommits(commits, skip, limit) {
  return {
    commits: commits.slice(skip, skip + limit),
    hasMore: commits.length > skip + limit,
  };
}

// Parse `git stash list --pretty=format:%gd%x1f%s%x1f%cr` stdout. Fields are
// unit-separator (\x1f) delimited, one stash per line. `%gd` is the selector
// (stash@{N}) used to apply/pop/drop a specific stash; `%s` is its message (git's
// default "WIP on <branch>: …" unless the user named it); `%cr` a relative date.
function parseStashList(stdout) {
  const stashes = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ref, message, relDate] = line.split('\x1f');
    stashes.push({ ref, message, relDate });
  }
  return stashes;
}

// Sum `git diff --numstat` output into a per-diff total. Each line is
// "<added>\t<deleted>\t<path>"; a binary file reports "-\t-" (no line counts),
// but it is still a changed file, so it counts toward `files` while contributing
// 0 to additions/deletions. Used to badge the per-session Diff button.
function sumNumstat(stdout) {
  let additions = 0, deletions = 0, files = 0;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [add, del] = line.split('\t');
    files++;
    if (add !== '-') additions += parseInt(add, 10) || 0;
    if (del !== '-') deletions += parseInt(del, 10) || 0;
  }
  return { additions, deletions, files };
}

// Decide whether a FAILED `git pull --ff-only` failed *because the branches
// diverged* (a real merge is needed) rather than for an unrelated reason (no
// upstream, network, auth). Only the divergence case is something a Claude
// session can resolve, so it's the one the renderer offers to hand off. git's
// ff-only refusal reads "fatal: Not possible to fast-forward, aborting." and the
// reconcile hint mentions "divergent branches" — match either, case-insensitively.
function pullNeedsMerge(stderr) {
  return /not possible to fast-forward|diverg/i.test(stderr || '');
}

// The push counterpart: a push the remote REJECTED because it has commits we don't
// (someone else pushed first). The fix is the same pull/merge/push a Claude session
// can do. git phrases this as "Updates were rejected … fetch first" / "non-fast-forward"
// / "tip of your current branch is behind". Auth/network/no-remote failures don't
// match, so those still surface as a plain error rather than a pointless merge offer.
function pushNeedsMerge(stderr) {
  return /fetch first|updates were rejected|non-fast-forward|behind its remote|tip of your current branch is behind/i.test(stderr || '');
}

// Build the branch selector's list from two `git for-each-ref` runs: `localOut`
// over refs/heads and `remoteOut` over refs/remotes. Local branches keep git's
// order (most-recent commit first); remote-tracking branches whose name has no
// local counterpart follow, so the selector can offer branches that only exist
// on the remote — checking one out makes a local tracking branch. `origin/HEAD`
// symbolic pointers are dropped, and two remotes carrying the same branch name
// collapse to one row. Each entry is { name, remote }: `remote:true` flags a
// remote-only branch (the full `origin/foo` name), which the renderer checks out
// by its short name and never offers to delete locally.
function parseBranches(localOut, remoteOut) {
  const split = (s) => (s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const local = split(localOut);
  const localSet = new Set(local);
  const branches = local.map((name) => ({ name, remote: false }));
  const seenRemote = new Set();
  for (const ref of split(remoteOut)) {
    if (ref.endsWith('/HEAD')) continue;
    const short = ref.slice(ref.indexOf('/') + 1);
    if (localSet.has(short) || seenRemote.has(short)) continue;
    seenRemote.add(short);
    branches.push({ name: ref, remote: true });
  }
  return branches;
}

// Re-order the (committerdate-sorted) branch list by *most recently used* — the
// order branches were last checked out — from the HEAD reflog, so a branch you
// switch to often but rarely commit on (e.g. `main`) still surfaces near the top
// of the empty-search list. Reflog subjects (`%gs`) read
// "checkout: moving from <a> to <b>"; the `<b>`s in reflog order (newest first)
// give the recency ranking. Branches never checked out — or aged out of the
// reflog, and any remote-tracking rows — keep their incoming committerdate order
// behind the used ones (a stable sort on the original index). So the result is
// "latest used, then latest edited".
function orderBranchesByUsage(branches, reflogStdout) {
  const rank = new Map();
  for (const line of (reflogStdout || '').split('\n')) {
    const m = /^checkout: moving from .+ to (.+)$/.exec(line.trim());
    if (m && !rank.has(m[1])) rank.set(m[1], rank.size);
  }
  const rankOf = (b) => (rank.has(b.name) ? rank.get(b.name) : Infinity);
  return branches
    .map((b, i) => ({ b, i }))
    .sort((x, y) => (rankOf(x.b) - rankOf(y.b)) || (x.i - y.i))
    .map((e) => e.b);
}

module.exports = { CONFLICT, parsePorcelain, parseLog, markPushed, markIncoming, filterCommits, pageCommits, parseStashList, sumNumstat, pullNeedsMerge, pushNeedsMerge, parseBranches, orderBranchesByUsage };
