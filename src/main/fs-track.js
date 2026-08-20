// Pure (Electron-free) helpers for the per-session filesystem-change tracker in
// sessions.js — kept here so the fiddly classification stays unit-tested
// (test/fs-track.test.js).

const path = require('path');

// Whether an absolute path is inside the session's repo. Everything the tracker
// records has to be: a per-session commit is a git commit, and a path outside the
// work tree can never be part of one. The one that actually shows up is the
// agent's own SCRATCHPAD (Claude Code hands each session a temp directory of its
// own): `git check-ignore` errors on a path outside the repo rather than calling
// it ignored, so scratchpad writes used to be recorded as edits — inflating the
// session's file count with files no commit could ever contain, which then
// vanished from the list the next time the session committed (sessionEntries
// drops out-of-repo paths and prunes them). Filtering them at the source keeps
// the count honest, and saves a `git check-ignore` spawn per scratchpad write.
function isInsideRepo(repo, abs) {
  if (!repo || !abs) return false;
  const rel = path.relative(repo, abs);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

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

// Hook events that end a stretch of agent work: the main agent finished its
// answer (Stop) or a subagent/sidechain finished (SubagentStop).
const TURN_END_EVENTS = new Set(['Stop', 'SubagentStop']);

// Snapshot/diff plan for the TURN-wide baseline — the second, coarser tracker
// that catches files the CLI changes OUTSIDE any tool window. The per-tool
// plans above only ever see changes made between a tracked tool's Pre and Post
// hooks; a write the CLI performs on its own (auto-memory files under the
// configured `autoMemoryDirectory`, for one — they land in the repo when that
// directory points inside it) happens in no tool window at all, so nothing
// attributed it to the session and the per-session commit silently omitted it.
//
// Baseline at the user's prompt, diff at each turn end:
// - `UserPromptSubmit` (main thread only) re-baselines WITHOUT diffing, so
//   anything the user did with their own editor while the session sat idle is
//   absorbed into the baseline rather than blamed on the session.
// - `Stop`/`SubagentStop` diff and immediately re-baseline, so a write that
//   lands just after the stop hook is still caught at the next turn end.
// - The Post of a bulk-VCS Bash command re-baselines too: a `git pull` mid-turn
//   is excluded from the per-tool diff (isBulkVcsCommand) and must not sneak
//   back in through the wider turn window.
// Returns 'snapshot' | 'diff-and-snapshot' | null.
function turnFsPlan(payload, hasBaseline) {
  const ev = payload.hook_event_name;
  if (ev === 'UserPromptSubmit') return payload.agent_id ? null : 'snapshot';
  if (TURN_END_EVENTS.has(ev)) return hasBaseline ? 'diff-and-snapshot' : 'snapshot';
  if (ev === 'PostToolUse' && payload.tool_name === 'Bash'
    && isBulkVcsCommand(payload.tool_input && payload.tool_input.command)) return 'snapshot';
  return null;
}

// A snapshot entry is the porcelain code plus a content stamp (`XY:<size>:<mtimeMs>`).
// The code alone can't see a file being changed AGAIN: one that was already dirty
// when the tool started still reads " M" afterwards, and an untracked file stays
// "??" however often a Bash command rewrites it — so every such change was
// silently dropped from the session's file list. The stamp makes the second write
// a real difference. Readers that want the code alone go through statusCode(),
// which also accepts a bare "XY" (persisted or hand-built snapshots).
function statusCode(entry) {
  return String(entry || '').slice(0, 2);
}

// Merge-conflict codes — never touch these; unstaging mid-conflict corrupts the
// resolution state git tracks in the index.
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// Paths a tool call newly STAGED, from its before/after porcelain snapshots
// (Map<relPath, "XY">; X is the index column). Agents sometimes run `git rm`/
// `git mv`/`git add`, which stage as a side effect — these are the paths the
// session tracker unstages again so the shared index stays under the user's
// control. A path already staged before the tool ran (e.g. by the user in the
// git pane) is not included.
function newlyStagedPaths(before, after) {
  const staged = (entry) => {
    const code = statusCode(entry);
    if (!code || CONFLICT_CODES.has(code)) return false;
    const x = code[0];
    return x !== ' ' && x !== '?' && x !== '!';
  };
  const out = [];
  for (const [rel, code] of after) {
    if (staged(code) && !staged(before.get(rel))) out.push(rel);
  }
  return out;
}

module.exports = { isBulkVcsCommand, tracksFs, editedFilePath, serialFsPlan, turnFsPlan, newlyStagedPaths, statusCode, isInsideRepo, TEXT_EDIT_TOOLS, READONLY_TOOLS };
