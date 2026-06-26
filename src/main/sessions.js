const { ipcMain } = require('electron');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { resolveClaude, runHaiku } = require('./claude');
const { editOp } = require('./edit-ops');
const { git } = require('./git');
// Runtime-only seam: hooksSettings()/getHookPort() are called when spawning a
// session (runtime), long after both modules have loaded — safe circular require.
const hookServer = require('./hook-server');

// id -> { pty, edits: Map<absPath, op[]>, fileOps: Map<absPath, 'add'|'delete'>,
//         preStatus, firstPrompt, name, suspended }
// `pty` is null while a session is suspended (archived in the UI): the Claude
// process is killed to free resources, but the entry — and all its tracked-file
// state — is kept so resuming under the same id continues tracking seamlessly.
const sessions = new Map();

// Tools whose effect we replay as text ops (handled via `edits`, not the
// filesystem diff below).
const TEXT_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Tools that never change the working tree — skip the (two `git status`) snapshot
// for these so only filesystem-touching tools pay for it. Anything NOT in either
// set (Bash, MCP tools, unknown tools) is assumed able to create/move/delete files.
const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch',
  'WebSearch', 'TodoWrite', 'Task', 'BashOutput', 'KillShell', 'NotebookRead', 'ExitPlanMode']);
const tracksFs = (name) => !!name && !TEXT_EDIT_TOOLS.has(name) && !READONLY_TOOLS.has(name);

// The session's full tracked-file list for the renderer's commit button: text
// edits plus path-level changes (binary creates, renames/moves, deletes).
function trackedFiles(s) {
  return [...new Set([...s.edits.keys(), ...s.fileOps.keys()])];
}

// Snapshot the working tree as Map<relPath, "XY"> (porcelain status code).
// --no-renames so a rename surfaces as a delete + an add (two paths we can each
// attribute), and --untracked-files=all so a new binary file lists individually.
async function statusMap() {
  const r = await git(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames']);
  const m = new Map();
  if (!r.ok) return m;
  for (const line of r.stdout.split('\n')) {
    if (line) m.set(line.slice(3), line.slice(0, 2));
  }
  return m;
}

// Diff a before/after status snapshot taken across one tool call and attribute
// each changed path to the session as an 'add' (file now present — a created
// binary, a moved-in file, or a Bash-modified file) or a 'delete' (file gone — a
// moved-out or removed file). Returns whether anything was recorded.
function applyFsDiff(s, before, after) {
  const repoPath = getRepoPath();
  let changed = false;
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(rel) === after.get(rel)) continue; // untouched by this tool
    const abs = path.resolve(repoPath, rel);
    if (fs.existsSync(abs)) {
      if (s.edits.has(abs)) continue; // a text-edit tool already covers this file
      s.fileOps.set(abs, 'add');
      changed = true;
    } else {
      s.edits.delete(abs); // the tool moved/removed it, so any recorded text ops are void
      // A file that was only ever untracked and is now gone never reached HEAD —
      // there is nothing to commit as a deletion, so just forget it.
      if ((before.get(rel) || '').startsWith('?')) { if (s.fileOps.delete(abs)) changed = true; }
      else { s.fileOps.set(abs, 'delete'); changed = true; }
    }
  }
  return changed;
}

// When the app is launched from VS Code's debugger (.vscode/launch.json), VS Code
// injects debugger/inspector variables into our env. node-pty would pass these to
// the spawned `claude` CLI — itself a Node process — which then boots as a
// debug-attached target and never starts the session. Strip them so a session
// spawns identically regardless of how the app itself was launched.
function sessionEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_INSPECTOR_OPTIONS;
  delete env.VSCODE_PID;
  if (env.NODE_OPTIONS) {
    const cleaned = env.NODE_OPTIONS
      .replace(/--require[= ]\S*(vscode|js-debug|bootloader)\S*/gi, '')
      .replace(/--inspect[\w-]*(=\S*)?/gi, '')
      .trim();
    if (cleaned) env.NODE_OPTIONS = cleaned; else delete env.NODE_OPTIONS;
  }
  return env;
}

// Attribute the user's first prompt and any edited files to their session, so
// we can later commit just that session's work. Returns updated meta, or null.
async function recordSessionActivity(payload) {
  const s = sessions.get(payload.session_id);
  if (!s) return null;
  let changed = false;
  if (payload.hook_event_name === 'UserPromptSubmit' && !s.firstPrompt && payload.prompt) {
    s.firstPrompt = String(payload.prompt).trim();
    generateSessionName(payload.session_id, s.firstPrompt);
    changed = true;
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const ti = payload.tool_input || {};
    const f = ti.file_path;
    if (f && TEXT_EDIT_TOOLS.has(payload.tool_name)) {
      if (!s.edits.has(f)) s.edits.set(f, []);
      s.edits.get(f).push(editOp(payload.tool_name, ti));
      changed = true;
    }
  }
  // Filesystem changes a text-edit tool can't express — a binary file a Bash/MCP
  // tool created, or a file it renamed/moved/deleted — are caught by diffing the
  // git working tree across the tool call: snapshot on PreToolUse, compare on
  // PostToolUse. Tools run sequentially within a session, so one `preStatus` slot
  // is enough; a missing snapshot (e.g. a Post with no Pre) just skips the diff.
  if (payload.hook_event_name === 'PreToolUse' && tracksFs(payload.tool_name)) {
    s.preStatus = await statusMap();
  } else if (payload.hook_event_name === 'PostToolUse' && tracksFs(payload.tool_name) && s.preStatus) {
    if (applyFsDiff(s, s.preStatus, await statusMap())) changed = true;
    s.preStatus = null;
  }
  return changed ? { id: payload.session_id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) } : null;
}

// Name a session from its first prompt via a one-shot Haiku call, then push
// `session-name` to the renderer.
async function generateSessionName(id, prompt) {
  // ponytail: 2000-char cap is plenty for a title; bump if titles read truncated
  const text = 'Reply with ONLY a 2-4 word title (no quotes, no trailing punctuation) '
    + 'for this coding session:\n\n' + prompt.slice(0, 2000);
  const out = await runHaiku(text, { cwd: getRepoPath() });
  if (!out) return;
  const name = out.split('\n').pop().trim().slice(0, 60);
  const s = sessions.get(id);
  if (name && s) { s.name = name; sendToRenderer('session-name', { id, name }); }
}

// Spawn the Claude PTY for `id` and wire its data/exit streams. `resume` starts
// `claude --resume <id>` (continuing the existing conversation under the same id,
// so hooks keep firing with the same session_id) instead of creating a new one.
function spawnPty(id, cols, rows, resume) {
  const startArg = resume ? ['--resume', id] : ['--session-id', id];
  const p = pty.spawn(resolveClaude(), [...startArg, '--settings', hookServer.hooksSettings()], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: getRepoPath(),
    env: sessionEnv(),
  });
  p.onData((data) => { sendToRenderer('pty-data', { id, data }); });
  p.onExit(() => {
    const s = sessions.get(id);
    // A suspend (archive) kills the PTY on purpose but keeps the entry and its
    // tracked-file state alive for a later resume — don't tear it down here.
    if (s && s.suspended) return;
    sessions.delete(id);
    sendToRenderer('status', { id, state: 'completed' });
  });
  return p;
}

ipcMain.handle('new-session', (_e, { cols, rows }) => {
  const id = crypto.randomUUID();
  const p = spawnPty(id, cols, rows, false);
  sessions.set(id, { pty: p, edits: new Map(), fileOps: new Map(), preStatus: null, firstPrompt: '', name: '', suspended: false });
  return { id, repo: getRepoPath() };
});

// Archive: kill the Claude process to free resources but keep the session entry
// (and all its tracked-file state) so it can resume under the same id.
ipcMain.on('suspend-session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s || !s.pty) return;
  s.suspended = true;
  try { s.pty.kill(); } catch { /* already gone */ }
  s.pty = null;
});

// Restore: respawn the PTY (resuming the same Claude conversation) for an entry
// that was suspended; its edits/fileOps continue accumulating against the same id.
ipcMain.handle('resume-session', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  s.suspended = false;
  s.pty = spawnPty(id, cols, rows, true);
  return { ok: true, repo: getRepoPath() };
});

ipcMain.on('pty-input', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s && s.pty) s.pty.write(data);
});
ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s && s.pty) try { s.pty.resize(cols, rows); } catch { /* race on close */ }
});
ipcMain.on('kill-session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.pty) try { s.pty.kill(); } catch { /* already gone */ }
  sessions.delete(id);
});

function killAllSessions() {
  for (const s of sessions.values()) try { if (s.pty) s.pty.kill(); } catch {}
}

module.exports = { sessions, recordSessionActivity, trackedFiles, killAllSessions };
