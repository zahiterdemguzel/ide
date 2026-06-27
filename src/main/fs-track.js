// Pure (Electron-free) helpers for the per-session filesystem-change tracker in
// sessions.js — kept here so the fiddly classification stays unit-tested
// (test/fs-track.test.js).

// git subcommands that REPLACE working-tree contents out of git history rather
// than the agent authoring files: pull/merge/rebase/reset/stash/cherry-pick/
// revert/clone/switch, and a branch checkout. The files such a command changes
// are git STATE MOVES, not this session's work — so the fs-diff tracker must not
// attribute them to the session, or a single `git pull` inflates the per-session
// commit with dozens of files the agent never wrote. (This IDE even spawns
// sessions specifically to resolve merges, so an un-skipped `git pull`/`merge`
// was the main source of a bogus "Commit 20 files".)
//
// Deliberately NOT here — these are real path-level edits the tracker SHOULD
// catch: `git mv`, `git rm`, `git add`, and a pathspec checkout
// (`git checkout -- file`, which has a `--` separator, handled below).
const BULK_VCS = new Set(['pull', 'merge', 'rebase', 'reset', 'stash',
  'cherry-pick', 'revert', 'clone', 'switch', 'checkout']);

// git global options that take a following argument, so we skip BOTH tokens when
// scanning for the subcommand (e.g. `git -C /repo pull` → subcommand is `pull`).
const ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// True when `command` runs at least one git subcommand that wholesale-replaces the
// working tree. Handles compound commands (`git fetch && git merge …`) and global
// options by scanning tokens: every `git` token is followed by its options (which
// we skip) and then its subcommand.
function isBulkVcsCommand(command) {
  if (!command || typeof command !== 'string') return false;
  const tokens = command.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git') continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith('-')) {
      if (ARG_OPTS.has(tokens[j])) j++; // this option consumes the next token too
      j++;
    }
    const sub = tokens[j];
    if (!BULK_VCS.has(sub)) continue;
    // A checkout is only a branch switch when it has no `--` pathspec separator;
    // `git checkout -- file` / `git checkout HEAD -- file` restores a file and is
    // a real working-tree edit we want to keep tracking.
    if (sub === 'checkout' && tokens.slice(j + 1).includes('--')) continue;
    return true;
  }
  return false;
}

module.exports = { isBulkVcsCommand };
