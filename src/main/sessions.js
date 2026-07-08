const { ipcMain } = require('electron');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { sendToRenderer } = require('./window');
const { getRepoPath, setGitScope } = require('./repo');
const { resolveClaude, runHaiku, claudeAvailable, readUsage } = require('./claude');
const { installGuide } = require('./claude-install');
const { cleanEnv } = require('./proc-env');
const { modelEnv } = require('./agent-models');
const { feedModelInput } = require('./model-parse');
const { editOp } = require('./edit-ops');
const { tracksFs, editedFilePath, TEXT_EDIT_TOOLS } = require('./fs-track');
const { git } = require('./git');
const { sharedDataDir } = require('./instance');
const { serializeSession, deserializeSession, isSessionPersistable, sessionBytes, enforceLimit, persistedState } = require('./session-persist');
const { interruptState } = require('./hook-events');
// Runtime-only seam: hooksSettings()/getHookPort() are called when spawning a
// session (runtime), long after both modules have loaded — safe circular require.
const hookServer = require('./hook-server');
const statusline = require('./statusline');
const worktrees = require('./worktrees');
const { mergeHasConflicts } = require('./worktrees-lib');

// id -> { pty, edits: Map<absPath, op[]>, fileOps: Map<absPath, 'add'|'delete'>,
//         preStatus, fsInFlight, firstPrompt, name, archived, suspended }
// `pty` is null while a session is suspended (archived in the UI, or freshly
// restored from disk after a restart): the Claude process is killed/absent to free
// resources, but the entry — and all its tracked-file state — is kept so resuming
// under the same id continues tracking seamlessly. `archived` is the UI tab the
// session lives in; `suspended` is whether the PTY is currently down (always true
// for a restored session until the user resumes it).
const sessions = new Map();

// Persisted across restarts in the shared data dir (not the disposable per-instance
// profile), so sessions survive closing the app — both active and archived ones.
// Each session is its own file under sessionsDir (`<id>.json`) so a single session's
// change only rewrites that one file (a fast, incremental save) and the whole set is
// never serialized at once. The legacy single-file store (`sessions.json`) is
// migrated into per-session files on first load, then deleted.
const sessionsDir = path.join(sharedDataDir, 'sessions');
const legacySessionsFile = path.join(sharedDataDir, 'sessions.json');

// Monotonic creation order, persisted per session as `_seq`. The Map's own insertion
// order is the live source of truth (oldest-first), but per-file storage loses it on
// restart, so `_seq` restores the same order on load (and drives oldest-first
// eviction). New sessions take the next value; on load it's bumped past the max seen.
let seqCounter = 0;

function sessionFilePath(id) {
  return path.join(sessionsDir, encodeURIComponent(id) + '.json');
}

function ensureSessionsDir() {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

// Write a session file atomically: a full write to a sibling temp file followed by a
// rename (atomic on the same filesystem). A plain writeFileSync can leave an empty or
// truncated file if the app is killed or crashes mid-write (e.g. during quit), which
// then fails to parse on the next launch. The rename guarantees a reader only ever
// sees the old complete file or the new complete one, never a half-written one.
function writeSessionFileAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// Delete one session's file (on kill or eviction). A missing file is fine — the
// session may never have been written yet.
function removeSessionFile(id) {
  try { fs.unlinkSync(sessionFilePath(id)); }
  catch (err) { if (err.code !== 'ENOENT') reportSessionError('removing a saved session', err); }
}

// One-time migration of the old single-file store into per-session files, so an
// existing install keeps its sessions. Each entry becomes its own file (carrying a
// fresh `_seq` to preserve the array order); the legacy file is then removed.
function migrateLegacyStore() {
  let raw;
  try { raw = fs.readFileSync(legacySessionsFile, 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') reportSessionError('reading saved sessions', err); return; }
  let list;
  try { list = JSON.parse(raw); }
  catch (err) { reportSessionError('reading saved sessions', err); return; }
  if (Array.isArray(list)) {
    ensureSessionsDir();
    let seq = 0;
    for (const obj of list) {
      if (!obj || typeof obj.id !== 'string') continue;
      try { writeSessionFileAtomic(sessionFilePath(obj.id), JSON.stringify({ ...obj, _seq: seq++ })); }
      catch (err) { reportSessionError('saving a session', err); }
    }
  }
  try { fs.unlinkSync(legacySessionsFile); } catch { /* best-effort cleanup */ }
}

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

// Repopulate `sessions` from disk on load (oldest-first order restored from `_seq`),
// so the renderer can rebuild its list on startup. Restored entries have no PTY; they
// resume under the same id on demand. A missing directory is normal (first run); a
// file that can't be read/parsed is surfaced so corrupt session state is visible
// rather than silently dropped, and one bad file never aborts the rest.
function loadPersistedSessions() {
  migrateLegacyStore();
  let files;
  try { files = fs.readdirSync(sessionsDir); }
  catch (err) { if (err.code !== 'ENOENT') reportSessionError('reading saved sessions', err); return; }
  const snapshots = [];
  for (const file of files) {
    // Leftover temp files from an interrupted atomic write are stale, not sessions.
    if (file.endsWith('.json.tmp')) { try { fs.unlinkSync(path.join(sessionsDir, file)); } catch { /* best-effort */ } continue; }
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(sessionsDir, file);
    let obj;
    // A file that can't be parsed (e.g. empty/truncated by a crash mid-write) is
    // unrecoverable. Report it once, then delete it so the same error doesn't resurface
    // on every launch.
    try { obj = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (err) {
      reportSessionError('reading saved sessions', err);
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      continue;
    }
    if (!obj || typeof obj.id !== 'string') continue;
    snapshots.push(obj);
  }
  snapshots.sort((a, b) => (a._seq || 0) - (b._seq || 0));
  for (const obj of snapshots) {
    try {
      const entry = deserializeSession(obj);
      // An empty husk (created but never prompted, no tracked work) has no transcript
      // to resume — it only ever produces the "No conversation found" error. Drop it
      // and delete its stale file so it can't resurrect on every launch.
      if (!isSessionPersistable(entry)) { removeSessionFile(obj.id); continue; }
      entry._seq = obj._seq || 0;
      sessions.set(obj.id, entry);
      seqCounter = Math.max(seqCounter, entry._seq + 1);
    } catch (err) { reportSessionError('restoring a saved session', err); }
  }
}
loadPersistedSessions();

// Drop the oldest evictable sessions whenever the on-disk set would exceed the 100 MB
// budget. A session with a live PTY (one the user is actively running) is never
// evicted. Evicted sessions are removed from memory, disk, and the UI so "old
// sessions get deleted" holds at runtime, not just on disk. Returns the surviving ids.
function evictOverBudget() {
  const measured = [...sessions].map(([id, s]) => ({
    id,
    bytes: sessionBytes(serializeSession(id, s)),
    evictable: !s.pty, // never evict a session the user is actively running
  }));
  const { evictedIds } = enforceLimit(measured);
  if (!evictedIds.length) return;
  for (const id of evictedIds) {
    const s = sessions.get(id);
    if (s && s.pty) try { s.pty.kill(); } catch { /* already gone */ }
    sessions.delete(id);
    removeSessionFile(id);
  }
  sendToRenderer('session-evicted', { ids: evictedIds });
}

// Write one session to its own file (the common case: a single session changed). The
// `_seq` rides along so load can restore creation order. Evicts over-budget sessions
// after the write. A throw here must never crash the app — it's surfaced instead.
function persistSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  // A session with no conversation and no tracked work isn't worth saving — and
  // resuming it later fails with "No conversation found" (see isSessionPersistable).
  // `new-session` persists on create, so this is the no-op that keeps a never-used
  // session off disk until its first prompt; clear any older file just in case.
  if (!isSessionPersistable(s)) { removeSessionFile(id); return; }
  try {
    ensureSessionsDir();
    if (s._seq === undefined) s._seq = seqCounter++;
    writeSessionFileAtomic(sessionFilePath(id), JSON.stringify({ ...serializeSession(id, s), _seq: s._seq }));
    evictOverBudget();
  } catch (err) {
    reportSessionError('saving a session', err);
  }
}

// Write every session to disk (used on quit). Synchronous so it completes before the
// process exits. Evicts first so an over-budget set never writes files it's about to
// delete. A throw here would otherwise be an uncaught exception on quit — surface it.
function persistSessions() {
  try {
    evictOverBudget();
    ensureSessionsDir();
    for (const [id, s] of sessions) {
      if (!isSessionPersistable(s)) { removeSessionFile(id); continue; }
      if (s._seq === undefined) s._seq = seqCounter++;
      writeSessionFileAtomic(sessionFilePath(id), JSON.stringify({ ...serializeSession(id, s), _seq: s._seq }));
    }
  } catch (err) {
    reportSessionError('saving sessions', err);
  }
}

// Coalesce the high-frequency edit stream (every recorded PostToolUse) into one write
// per session shortly after activity settles. Discrete user actions (archive, resume,
// commit, new session, name) call persistSession() directly for an immediate save.
const persistTimers = new Map();
function schedulePersist(id) {
  if (persistTimers.has(id)) clearTimeout(persistTimers.get(id));
  persistTimers.set(id, setTimeout(() => { persistTimers.delete(id); persistSession(id); }, 1000));
}

// Record a session's current status-dot state so it survives a restart (the hook
// server drives this from the live event stream; commit-session marks 'pushed').
// Only a `working` session reopens as `interrupted` on disk; the settled states
// (`completed`/`pushed`/`idle`, and `needs-input` collapsed to green) are kept (see
// persistedState) — but we store the live value so a later transition to a settled
// state is captured. No-op for an unknown/evicted id.
function setSessionState(id, state) {
  const s = sessions.get(id);
  if (!s || s.state === state) return;
  s.state = state;
  persistSession(id);
}

// The session's current status-dot state (undefined for an unknown id). The hook
// server reads this to avoid the SessionStart `idle` reset wiping a resumed
// session's saved colour (completed/pushed/interrupted) before any new work runs.
function getSessionState(id) {
  return sessions.get(id)?.state;
}

// The tool classification (text-edit / read-only / fs-tracked) lives in the
// pure fs-track.js (unit-tested in test/fs-track.test.js).

// The session's full tracked-file list for the renderer's commit button: text
// edits plus path-level changes (binary creates, renames/moves, deletes).
function trackedFiles(s) {
  return [...new Set([...s.edits.keys(), ...s.fileOps.keys()])];
}

// True when a session OTHER than `self` already owns this absolute path. Text
// edits (`edits`) are an EXACT, per-session-attributed signal — the hook payload
// carries the session id and file path. The working-tree diff that fills
// `fileOps` is GLOBAL and can't tell sessions apart, so when two sessions run
// concurrently (one editing code, one running a Bash/MCP command) the diff would
// otherwise attribute the editor's file to the other session. This predicate is
// how that change is kept out of the wrong session. `kinds` selects which maps to
// consult — fileOp attribution checks both (text-edit authority + first-recorder-
// wins for two fs-only sessions); the commit/diff read path checks only `edits`,
// since a path another session edited precisely must never be swept into this
// session's whole-file blob.
function pathClaimedByOther(self, abs, { edits = true, fileOps = true } = {}) {
  for (const [, o] of sessions) {
    if (o === self) continue;
    if (edits && o.edits.has(abs)) return true;
    if (fileOps && o.fileOps.has(abs)) return true;
  }
  return false;
}

// The directory a session's git-tracked work lives in: its own worktree when it
// has one (and it still exists on disk — a vanished worktree falls back rather
// than erroring every call), else the repo it was created in.
function workdirOf(s) {
  if (s && s.workdir && fs.existsSync(s.workdir)) return s.workdir;
  return (s && s.repo) || getRepoPath();
}

// True when `absPath` is excluded by .gitignore. `git check-ignore` reports
// nothing (exit 1) for a tracked file even if it matches an ignore rule, so this
// is exactly "untracked AND ignored" — the files we must never track or commit.
// The filesystem-diff path already excludes these (they don't appear in `git
// status`); this guards the text-edit path, which records by file path directly.
async function isIgnored(absPath, cwd) {
  const r = await git(['check-ignore', '-q', '--', absPath], { cwd });
  return r.ok; // exit 0 = ignored
}

// Snapshot the working tree as Map<relPath, "XY"> (porcelain status code).
// --no-renames so a rename surfaces as a delete + an add (two paths we can each
// attribute), and --untracked-files=all so a new binary file lists individually.
async function statusMap(cwd) {
  const r = await git(['status', '--porcelain=v1', '--untracked-files=all', '--no-renames'], { cwd });
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
  const repoPath = workdirOf(s); // rel paths came from a status run in this dir
  let changed = false;
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(rel) === after.get(rel)) continue; // untouched by this tool
    const abs = path.resolve(repoPath, rel);
    // The status snapshot is global, so a file ANOTHER session changed during
    // this tool's window shows up here too. If that session already owns the path
    // (its exact text edits, or a filesystem change it recorded first), the change
    // is theirs — don't attribute it to this Bash/MCP tool. See per-session commit
    // "Known ceilings".
    if (pathClaimedByOther(s, abs)) continue;
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
// debug-attached target and never starts the session. `cleanEnv` strips them so a
// session spawns identically regardless of how the app itself was launched. The same
// scrub guards the console PTYs (incl. the setup install/auth terminal), which run the
// same `claude` binary — see src/main/proc-env.js.
// `models` ({ model, subagentModel }) is the session's per-session agent choice:
// modelEnv turns it into ANTHROPIC_MODEL / CLAUDE_CODE_SUBAGENT_MODEL overrides so
// the spawned CLI runs the chosen model for the main agent and its subagents (a
// `default`/empty selection sets nothing and the CLI resolves the model normally).
function sessionEnv(models) {
  return { ...cleanEnv(process.env), ...modelEnv(models) };
}

// Attribute the user's first prompt and any edited files to their session, so
// we can later commit just that session's work. Returns updated meta, or null.
async function recordSessionActivity(payload) {
  const s = sessions.get(payload.session_id);
  if (!s) return null;
  let changed = false;
  // Only a MAIN-THREAD prompt (no agent_id — Claude Code sets it only inside a
  // subagent's own context) may reset the tracker or name the session: a
  // subagent's UserPromptSubmit arrives while main-thread fs tools are still in
  // flight, so letting it wipe fsInFlight/preStatus here would drop the pending
  // snapshot and silently lose those tools' filesystem changes.
  if (payload.hook_event_name === 'UserPromptSubmit' && !payload.agent_id) {
    // A new user turn means the agent is idle (no tool in flight), so reset the
    // fs-tracking counter — self-heals a stuck count if a Post hook ever failed
    // to fire, which would otherwise suppress every later snapshot.
    s.fsInFlight = 0;
    s.preStatus = null;
    if (!s.firstPrompt && payload.prompt) {
      s.firstPrompt = String(payload.prompt).trim();
      generateSessionName(payload.session_id, s.firstPrompt);
      changed = true;
    }
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const ti = payload.tool_input || {};
    // editedFilePath also reads NotebookEdit's `notebook_path` — subagent edits
    // (payloads carrying agent_id) land here too, same session_id, and belong to
    // the session just like main-thread ones.
    const f = editedFilePath(ti);
    // Skip .gitignore'd files: tracking them here would let commit-session add
    // them to the repo (and, once tracked, surface them in the changes panel).
    if (f && TEXT_EDIT_TOOLS.has(payload.tool_name) && !(await isIgnored(f, workdirOf(s)))) {
      if (!s.edits.has(f)) s.edits.set(f, []);
      s.edits.get(f).push(editOp(payload.tool_name, ti));
      changed = true;
    }
  }
  // Filesystem changes a text-edit tool can't express — a binary file a Bash/MCP
  // tool created, or a file it renamed/moved/deleted — are caught by diffing the
  // git working tree across the tool call: snapshot before the first fs tool of a
  // burst, compare once the last one finishes. Claude runs tool calls in PARALLEL
  // within a turn, so the Pre/Post hooks interleave; a single snapshot slot would
  // let a second Pre clobber it and a Post-without-Pre drop its changes entirely.
  // Instead we ref-count the fs tools in flight (`fsInFlight`): snapshot when the
  // count goes 0→1, diff once it returns to 0, against that one consistent
  // baseline — so every concurrent tool's changes are captured exactly once.
  if (payload.hook_event_name === 'PreToolUse' && tracksFs(payload)) {
    if ((s.fsInFlight || 0) === 0) s.preStatus = await statusMap(workdirOf(s));
    s.fsInFlight = (s.fsInFlight || 0) + 1;
  } else if (payload.hook_event_name === 'PostToolUse' && tracksFs(payload)) {
    s.fsInFlight = Math.max(0, (s.fsInFlight || 0) - 1);
    if (s.fsInFlight === 0 && s.preStatus) {
      if (applyFsDiff(s, s.preStatus, await statusMap(workdirOf(s)))) changed = true;
      s.preStatus = null;
    }
  }
  if (changed) schedulePersist(payload.session_id);
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
  if (name && s) { s.name = name; sendToRenderer('session-name', { id, name }); persistSession(id); }
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
    // A worktree session spawns in its own worktree so every file the agent
    // touches (and every git command it runs) lands on its session branch.
    cwd: s ? workdirOf(s) : getRepoPath(),
    // Re-apply the session's model choice on resume too, so a restored session
    // keeps running the model it was created with.
    env: sessionEnv(s),
  });
  p.onData((data) => { sendToRenderer('pty-data', { id, data }); });
  p.onExit(() => {
    const s = sessions.get(id);
    // The PTY dying takes every agent (main + subagents) down with it, however it
    // died — exit, archive, or close — so the hook server's subagent bookkeeping
    // for this session is stale either way.
    hookServer.clearTracking(id);
    // A suspend (archive) kills the PTY on purpose but keeps the entry and its
    // tracked-file state alive for a later resume — don't tear it down here.
    if (s && s.suspended) return;
    sessions.delete(id);
    // A non-persistable session that just exited is an empty husk — most often a
    // `claude --resume <id>` that failed with "No conversation found". Delete its
    // file so it doesn't come back on the next launch.
    if (s && !isSessionPersistable(s)) removeSessionFile(id);
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
    model: s.model || '', workdir: s.workdir || '', branch: s.branch || '',
  }));
}, []));

// Availability gate: is the Claude Code CLI installed? The renderer calls this on
// every launch and guides the user through installing it before any session can
// spawn (see claude-setup.js). The platform-specific install commands ride along
// so the renderer needs no OS logic.
ipcMain.handle('check-claude', async () => ({ ...await claudeAvailable(), guide: installGuide() }));

// Remaining Claude subscription usage (5h + weekly rolling windows) for the
// toolbar meter, read live from the Messages API's unified rate-limit headers.
// Polled ~once a minute by the renderer; null when unavailable (no OAuth token,
// an API-key user, or a transport error) so the meter stays hidden.
ipcMain.handle('get-usage', async () => {
  try { return await readUsage(); } catch { return null; }
});

// Settings → General → per-session token meter on/off. The renderer pushes the
// saved value on startup and whenever it changes; it gates whether the next
// spawned session gets a statusLine (live sessions keep what they spawned with).
ipcMain.on('set-statusline-enabled', (_e, on) => statusline.setEnabled(on));

// Settings → General → git worktree per session on/off (default off). Pushed by
// the renderer on startup and on change; gates the NEXT session's spawn only.
ipcMain.on('set-worktrees-enabled', (_e, on) => worktrees.setEnabled(on));

// Scope the git pane to a session's worktree (or back to the main checkout with
// a null/unknown id). The renderer pushes this on every session select.
ipcMain.on('set-git-scope', guardOn('scoping the git pane', (_e, { id }) => {
  const s = id ? sessions.get(id) : null;
  setGitScope(s && s.workdir && fs.existsSync(s.workdir) ? s.workdir : null);
}));

ipcMain.handle('new-session', guard('creating a session', async (_e, { cols, rows, model, subagentModel, plain }) => {
  const id = crypto.randomUUID();
  const repo = getRepoPath();
  // With the worktree setting on, the session gets its own worktree + branch so
  // parallel sessions never share a working tree. `plain` skips it regardless —
  // used for sessions that must operate on the MAIN checkout (e.g. the git pane
  // handing a merge/conflict resolution to Claude). Falls back to a normal
  // shared-tree session when the worktree can't be created (non-git folder, no
  // commits yet).
  const wt = (!plain && worktrees.isEnabled()) ? await worktrees.createSessionWorktree(id, repo) : null;
  // Create the entry before spawning so spawnPty resolves the session's cwd to its
  // own repo. `model`/`subagentModel` are the per-session agent choice (see
  // sessionEnv); stored on the record so they survive archive/resume and a restart.
  sessions.set(id, { pty: null, repo, workdir: wt ? wt.workdir : '', branch: wt ? wt.branch : '', edits: new Map(), fileOps: new Map(), preStatus: null, fsInFlight: 0, firstPrompt: '', name: '', archived: false, state: 'idle', suspended: false, model: model || '', subagentModel: subagentModel || '', _seq: seqCounter++ });
  sessions.get(id).pty = spawnPty(id, cols, rows, false);
  persistSession(id);
  return { id, repo, workdir: wt ? wt.workdir : '', branch: wt ? wt.branch : '' };
}, (err) => ({ error: err && err.message ? err.message : String(err) })));

// Merge a worktree session's branch back into the branch checked out in the MAIN
// repo. The renderer commits the session's outstanding work first (the regular
// commit-session), so the branch holds everything. A conflicted merge is left in
// progress in the main checkout and flagged `needsMerge` so the renderer can
// offer to hand the resolution to a Claude session (same flow as pull/push).
ipcMain.handle('merge-session', guard('merging a session branch', async (_e, id) => {
  const s = sessions.get(id);
  if (!s || !s.branch) return { ok: false, stderr: 'This session has no worktree branch' };
  const repo = s.repo || getRepoPath();
  const cur = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
  if (cur.ok && cur.stdout.trim() === s.branch) return { ok: false, stderr: 'The main checkout is on the session branch itself' };
  const r = await git(['merge', '--no-edit', s.branch], { cwd: repo });
  return { ...r, needsMerge: !r.ok && mergeHasConflicts(r.stdout + '\n' + r.stderr) };
}, (err) => ({ ok: false, stderr: err && err.message ? err.message : String(err) })));

// Archive: kill the Claude process to free resources but keep the session entry
// (and all its tracked-file state) so it can resume under the same id.
ipcMain.on('suspend-session', guardOn('archiving a session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.suspended = true;
  s.archived = true;
  // Archiving stops the agent: a session that was actively working can't keep
  // running, so reflect it as interrupted (red) — same rule app-close uses
  // (persistedState). A session merely paused for input, and the settled states
  // (completed/pushed/idle), pass through as their green/settled colour.
  const stopped = persistedState(s.state);
  if (stopped !== s.state) sendToRenderer('status', { id, state: stopped });
  setSessionState(id, stopped);
  if (s.pty) { try { s.pty.kill(); } catch { /* already gone */ } s.pty = null; }
  persistSession(id);
}));

// Restore: respawn the PTY (resuming the same Claude conversation) for an entry
// that was suspended; its edits/fileOps continue accumulating against the same id.
ipcMain.handle('resume-session', guard('restoring a session', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (!s) return { ok: false };
  s.suspended = false;
  s.archived = false;
  s.pty = spawnPty(id, cols, rows, true);
  persistSession(id);
  return { ok: true, repo: getRepoPath() };
}, { ok: false }));

// Change a session's model. Originally fixed at spawn
// (ANTHROPIC_MODEL via sessionEnv), the model can now be retargeted live — the
// record is updated so it survives archive/resume and a restart (spawnPty re-applies
// it), and if the PTY is live we drive the CLI's own `/model <id>` slash command so
// the running session switches immediately. `default` maps to `/model default` (reset
// to the CLI default). The renderer owns the list of valid ids.
ipcMain.on('set-session-model', guardOn('changing session model', (_e, { id, model }) => {
  const s = sessions.get(id);
  if (!s) return;
  const chosen = typeof model === 'string' ? model.trim() : '';
  if (!chosen) return;
  s.model = chosen;
  persistSession(id);
  if (s.pty) s.pty.write(`/model ${chosen}\r`);
}));

ipcMain.on('pty-input', guardOn('writing to a session', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (!s || !s.pty) return;
  s.pty.write(data);
  // Track a `/model <id>` typed into the chat (the badge's own dropdown writes
  // via set-session-model, which bypasses this handler, so there's no echo to
  // double-count).
  const mdl = feedModelInput(s.modelInputBuf || '', data);
  s.modelInputBuf = mdl.buf;
  if (mdl.model && mdl.model !== s.model) {
    s.model = mdl.model;
    persistSession(id);
    sendToRenderer('session-model', { id, model: mdl.model });
  }
  // ESC/Ctrl+C while the agent is working interrupts the turn (no hook fires for
  // it, so we read it off the input). Mirror the dot in the renderer and persist.
  const interrupted = interruptState(data, s.state);
  if (interrupted) {
    setSessionState(id, interrupted);
    sendToRenderer('status', { id, state: interrupted });
  }
}));
ipcMain.on('pty-resize', guardOn('resizing a session', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s && s.pty) try { s.pty.resize(cols, rows); } catch { /* race on close */ }
}));
ipcMain.on('kill-session', guardOn('closing a session', (_e, { id }) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.pty) try { s.pty.kill(); } catch { /* already gone */ }
  // Best-effort worktree cleanup; the session branch is kept (see worktrees.js).
  worktrees.removeSessionWorktree(s).catch(() => {});
  sessions.delete(id);
  if (persistTimers.has(id)) { clearTimeout(persistTimers.get(id)); persistTimers.delete(id); }
  removeSessionFile(id);
}));

function killAllSessions() {
  for (const s of sessions.values()) try { if (s.pty) s.pty.kill(); } catch {}
}

module.exports = { sessions, recordSessionActivity, setSessionState, getSessionState, trackedFiles, pathClaimedByOther, workdirOf, killAllSessions, persistSession, persistSessions, reportSessionError, guard };
