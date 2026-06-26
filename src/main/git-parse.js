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

module.exports = { CONFLICT, parsePorcelain, parseLog };
