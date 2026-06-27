const { ipcMain } = require('electron');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { resolveClaude, runHaiku, claudeAvailable } = require('./claude');
const { installGuide } = require('./claude-install');
const { editOp } = require('./edit-ops');
const { git } = require('./git');
const { sharedDataDir } = require('./instance');
const { serializeSession, deserializeSession, sessionBytes, enforceLimit } = require('./session-persist');
// Runtime-only seam: hooksSettings()/getHookPort() are called when spawning a
// session (runtime), long after both modules have loaded — safe circular require.
const hookServer = require('./hook-server');

// id -> { pty, edits: Map<absPath, op[]>, fileOps: Map<absPath, 'add'|'delete'>,
//         preStatus, firstPrompt, name, archived, suspended }
// `pty` is null while a session is suspended (archived in the UI, or freshly
// restored from disk after a restart): the Claude process is killed/absent to free
// resources, but the entry — and all its tracked-file state — is kept so resuming
// under the same id continues tracking seamlessly. `archived` is the UI tab the
// session lives in; `suspended` is whether the PTY is currently down (always true
// for a restored session until the user resumes it).
const sessions = new Map();

// Persisted across restarts in the shared data dir (not the disposable per-instance
// profile), so sessions survive closing the app — both active and archived ones.
const sessionsFile = path.join(sharedDataDir, 'sessions.json');

// A session failing to save/load/commit/etc. must never crash the IDE; instead it
// surfaces as a warning dialog in the renderer (red error text, OK + Copy). Errors
// raised before the renderer exists (e.g. a corrupt sessions.json read at startup)
// are queued and flushed once the renderer asks for the session list.
const pendingSessionErrors = [];
function reportSessionError(context, err) {
  const message = err && err.stack ? err.stack : String(err);
  console.error('[session error]', context, message);
  if (!sendToRenderer('session-error', { context, message })) pendingSessionErrors.push({ context, message });
}
function flushSessionErrors() {
  while (pendingSessionErrors.length) {
    if (!sendToRenderer('session-error', pendingSessionErrors[0])) break;
    pendingSessionErrors.shift();
  }
}

// Wrap a session IPC handler so any throw becomes a reported warning + a safe
// return value, instead of a rejected invoke (an unhandled rejection in the
// renderer) or — for fire-and-forget `.on` handlers — an uncaught main-process
// exception. `fallback` is what the renderer gets back on failure.
function guard(context, fn, fallback) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (err) { reportSessionError(context, err); return typeof fallback === 'function' ? fallback(err) : fallback; }
  };
}
function guardOn(context, fn) {
  return (...args) => { try { fn(...args); } catch (err) { reportSessionError(context, err); } };
}

// Repopulate `sessions` from disk on load (oldest-first order preserved), so the
// renderer can rebuild its list on startup. Restored entries have no PTY; they
// resume under the same id on demand. A missing file is normal (first run); a file
// that exists but can't be read/parsed is surfaced so corrupt session state is
// visible rather than silently dropped, and one bad entry never aborts the rest.
function loadPersistedSessions() {
  let raw;
  try { raw = fs.readFileSync(sessionsFile, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') reportSessionError('reading saved sessions', err); return; }
  let list;
  try { list = JSON.parse(raw); }
  catch (err) { reportSessionError('reading saved sessions', err); return; }
  if (!Array.isArray(list)) return;
  for (const obj of list) {
    if (!obj || typeof obj.id !== 'string') continue;
    try { sessions.set(obj.id, deserializeSession(obj)); }
    catch (err) { reportSessionError('restoring a saved session', err); }
  }
}
loadPersistedSessions();

// Write the current session set to disk, evicting the oldest evictable sessions
// when the snapshot would exceed the 100 MB budget. Synchronous so it can run on
// quit before the process exits. Evicted sessions are also dropped from memory and
// the UI so "old sessions get deleted" holds at runtime, not just on disk.
function persistSessions() {
  try {
    const snapshots = [...sessions].map(([id, s]) => serializeSession(id, s));
    const measured = snapshots.map((o) => ({
      id: o.id,
      bytes: sessionBytes(o),
      evictable: !sessions.get(o.id)?.pty, // never evict a session the user is actively running
    }));
    const { evictedIds } = enforceLimit(measured);
    if (evictedIds.length) {
      for (const id of evictedIds) {
        const s = sessions.get(id);
        if (s && s.pty) try { s.pty.kill(); } catch { /* already gone */ }
        sessions.delete(id);
      }
      sendToRenderer('session-evicted', { ids: evictedIds });
    }
    const evicted = new Set(evictedIds);
    const kept = snapshots.filter((o) => !evicted.has(o.id));
    fs.writeFileSync(sessionsFile, JSON.stringify(kept));
  } catch (err) {
    // Runs from a timer and on quit — a throw here would otherwise be an uncaught
    // exception. Surface it instead so the user knows their sessions didn't save.
    reportSessionError('saving sessions', err);
  }
}

// Coalesce the frequent mutations (every recorded edit, name, archive toggle) into
// one write shortly after activity settles, instead of writing on each one.
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => { persistTimer = null; persistSessions(); }, 1000);
}

// Record a session's current status-dot state so it survives a restart (the hook
// server drives this from the live event stream; commit-session marks 'pushed').
// Only `completed`/`pushed` are kept verbatim on disk — everything else reopens as
// `interrupted` (see persistedState) — but we store the live value so a later
// transition to a settled state is captured. No-op for an unknown/evicted id.
function setSessionState(id, state) {
  const s = sessions.get(id);
  if (!s || s.state === state) return;
  s.state = state;
  schedulePersist();
}

// The session's current status-dot state (undefined for an unknown id). The hook
// server reads this to avoid the SessionStart `idle` reset wiping a resumed
// session's saved colour (completed/pushed/interrupted) before any new work runs.
function getSessionState(id) {
  return sessions.get(id)?.state;
}

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

// True when `absPath` is excluded by .gitignore. `git check-ignore` reports
// nothing (exit 1) for a tracked file even if it matches an ignore rule, so this
// is exactly "untracked AND ignored" — the files we must never track or commit.
// The filesystem-diff path already excludes these (they don't appear in `git
// status`); this guards the text-edit path, which records by file path directly.
async function isIgnored(absPath) {
  const r = await git(['check-ignore', '-q', '--', absPath]);
  return r.ok; // exit 0 = ignored
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
    // Skip .gitignore'd files: tracking them here would let commit-session add
    // them to the repo (and, once tracked, surface them in the changes panel).
    if (f && TEXT_EDIT_TOOLS.has(payload.tool_name) && !(await isIgnored(f))) {
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
  if (changed) schedulePersist();
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
  if (name && s) { s.name = name; sendToRenderer('session-name', { id, name }); schedulePersist(); }
}

// Spawn the Claude PTY for `id` and wire its data/exit streams. `resume` starts
// `claude --resume <id>` (continuing the existing conversation under the same id,
// so hooks keep firing with the same session_id) instead of creating a new one.
function spawnPty(id, cols, rows, resume) {
  const startArg = resume ? ['--resume', id] : ['--session-id', id];
  // Spawn in the session's own project folder, not whatever folder is currently
  // open — a session always belongs to the repo it was created in.
  const s = sessions.get(id);
  const p = pty.spawn(resolveClaude(), [...startArg, '--settings', hookServer.hooksSettings()], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: (s && s.repo) || getRepoPath(),
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

// Return the restored sessions so the renderer can rebuild its list on startup.
// Only the UI-facing fields are sent; the tracked-file list drives the per-session
// commit button immediately, before the session is even resumed.
ipcMain.handle('get-sessions', guard('reading saved sessions', () => {
  // The renderer is alive by the time it asks for the list, so flush any errors
  // queued during the pre-renderer startup load (e.g. a corrupt sessions.json).
  flushSessionErrors();
  return [...sessions].map(([id, s]) => ({
    id, repo: s.repo || '', firstPrompt: s.firstPrompt || '', name: s.name || '',
    archived: !!s.archived, state: s.state || 'idle', files: trackedFiles(s),
  }));
}, []));

// First-run gate: is the Claude Code CLI installed? The renderer guides the user
// through installing it before any session can spawn (see claude-setup.js). The
// platform-specific install commands ride along so the renderer needs no OS logic.
ipcMain.handle('check-claude', async () => ({ ...await claudeAvailable(), guide: installGuide() }));

ipcMain.handle('new-session', guard('creating a session', (_e, { cols, rows }) => {
  const id = crypto.randomUUID();
  const repo = getRepoPath();
  // Create the entry before spawning so spawnPty resolves the session's cwd to its
  // own repo.
  sessions.set(id, { pty: null, repo, edits: new Map(), fileOps: new Map(), preStatus: null, firstPrompt: '', name: '', archived: false, state: 'idle', suspended: false });
  sessions.get(id).pty = spawnPty(id, cols, rows, false);
  schedulePersist();
  return { id, repo };
}, (err) => ({ error: err && err.message ? err.message : String(err) })));

// Archive: kill the Claude process to free resources but keep the session entry
// (and all its tracked-file state) so it can resume under the same id.
ipcMain.on('suspend-session', guardOn('archiving a session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.suspended = true;
  s.archived = true;
  if (s.pty) { try { s.pty.kill(); } catch { /* already gone */ } s.pty = null; }
  schedulePersist();
}));

// Restore: respawn the PTY (resuming the same Claude conversation) for an entry
// that was suspended; its edits/fileOps continue accumulating against the same id.
ipcMain.handle('resume-session', guard('restoring a session', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  s.suspended = false;
  s.archived = false;
  s.pty = spawnPty(id, cols, rows, true);
  schedulePersist();
  return { ok: true, repo: getRepoPath() };
}, { ok: false }));

ipcMain.on('pty-input', guardOn('writing to a session', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s && s.pty) s.pty.write(data);
}));
ipcMain.on('pty-resize', guardOn('resizing a session', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s && s.pty) try { s.pty.resize(cols, rows); } catch { /* race on close */ }
}));
ipcMain.on('kill-session', guardOn('closing a session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.pty) try { s.pty.kill(); } catch { /* already gone */ }
  sessions.delete(id);
  schedulePersist();
}));

function killAllSessions() {
  for (const s of sessions.values()) try { if (s.pty) s.pty.kill(); } catch {}
}

module.exports = { sessions, recordSessionActivity, setSessionState, getSessionState, trackedFiles, killAllSessions, persistSessions, reportSessionError, guard };
