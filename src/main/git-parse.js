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

module.exports = { CONFLICT, parsePorcelain, parseLog, markPushed, filterCommits, sumNumstat };
