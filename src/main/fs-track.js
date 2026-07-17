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

// Tools whose effect the session tracker replays as text ops (handled via
// `edits` in sessions.js, not the filesystem diff).
const TEXT_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Tools that never change the working tree — skip the (two `git status`) snapshot
// for these so only filesystem-touching tools pay for it. The subagent spawners
// (`Task` historically, `Agent` on newer CLIs) are here too: a subagent's OWN
// Pre/PostToolUse hooks fire with the parent session_id, so its file work is
// tracked directly — fs-tracking the wrapping call would just pin the in-flight
// counter for the subagent's whole (possibly minutes-long) run, and if that call
// is interrupted the stuck counter suppresses every later snapshot until the next
// prompt. Anything NOT in either set (Bash, MCP tools, unknown tools) is assumed
// able to create/move/delete files.
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch',
  'WebSearch', 'TodoWrite', 'Task', 'Agent', 'BashOutput', 'KillShell',
  'NotebookRead', 'ExitPlanMode']);

// Whether a tool call should be tracked by the working-tree diff. A tool is
// fs-tracked when it isn't a text-edit tool (those replay as ops) and isn't
// read-only — UNLESS it's a Bash command that only MOVES git state (pull/merge/
// reset/…): those files aren't the session's work, so attributing them would
// inflate the per-session commit. Computed from the whole payload, and used
// identically on Pre and Post so the in-flight counter stays balanced.
function tracksFs(payload) {
  const name = payload.tool_name;
  if (!name || TEXT_EDIT_TOOLS.has(name) || READONLY_TOOLS.has(name)) return false;
  if (name === 'Bash' && isBulkVcsCommand(payload.tool_input && payload.tool_input.command)) return false;
  return true;
}

// The file a text-edit tool touched. Most tools carry `file_path`; NotebookEdit
// alone names its target `notebook_path` — missing that made notebook edits
// invisible to the tracker (and they're excluded from the fs diff too, being a
// text-edit tool, so they vanished entirely).
function editedFilePath(toolInput) {
  const ti = toolInput || {};
  return ti.file_path || ti.notebook_path || null;
}

// Snapshot/diff plan for providers that run tools SERIALLY but don't guarantee
// a PostToolUse for every PreToolUse — Codex skips the Post hook when a tool
// errors (observed with apply_patch), so the claude-style balanced ref-count
// (`fsInFlight`) would stick above zero and suppress every later diff, losing
// the whole turn's file changes. Instead: snapshot before each tracked tool,
// diff at its Post — and if a Post went missing, the NEXT tracked Pre diffs
// against the stale baseline first (catching the orphaned tool's changes)
// before re-snapshotting. Stop flushes a baseline left dangling by the turn's
// last tool. Returns 'snapshot' | 'diff' | 'diff-and-snapshot' | null.
function serialFsPlan(payload, hasBaseline) {
  const ev = payload.hook_event_name;
  if (ev === 'PreToolUse' && tracksFs(payload)) return hasBaseline ? 'diff-and-snapshot' : 'snapshot';
  if ((ev === 'PostToolUse' || ev === 'Stop') && hasBaseline) return 'diff';
  return null;
}

module.exports = { isBulkVcsCommand, tracksFs, editedFilePath, serialFsPlan, TEXT_EDIT_TOOLS, READONLY_TOOLS };
