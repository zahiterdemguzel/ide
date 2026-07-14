// Pure (Electron-free) logic for persisting sessions across app restarts: turn an
// in-memory session entry into a JSON-safe snapshot and back, measure its size,
// and enforce the on-disk budget by evicting the oldest sessions. The fs/IPC glue
// lives in sessions.js; everything here is plain data so it stays unit-testable.

// The most we keep on disk for previous sessions and their tracking data. Once the
// snapshot would exceed this, the oldest evictable sessions are dropped (see
// enforceLimit) until it fits.
const MAX_PERSIST_BYTES = 100 * 1024 * 1024; // 100 MB

// The status-dot state we record on disk. Only a session whose agent was actively
// running — `working` (the yellow spinner) — when the app closed reopens as
// `interrupted` (red): that work was cut off and its Claude process can't outlive
// the app, so the in-flight state isn't real anymore. A `needs-input` session was
// *paused waiting for the user*, not crunching — it reads as green ("wants your
// attention"), same as a finished one, so it reopens `completed` rather than red;
// the live input prompt is gone after a restart, so we drop the glowing
// needs-input cue and keep the plain settled green. Every other state is kept
// verbatim: `completed` (green), `pushed` (purple), and `idle` (gray — a session
// created but never used).
function persistedState(state) {
  if (state === 'working') return 'interrupted';
  if (state === 'needs-input') return 'completed';
  return state || 'idle';
}

// Snapshot one live session entry to a plain object. The PTY and the transient
// pre-tool git-status snapshot are runtime-only and deliberately omitted; the Maps
// become arrays so JSON.stringify can round-trip them. `archived` records the UI
// tab the session belongs to (an archived session restores into the Archived tab).
// `state` is collapsed to a persistable status dot (see persistedState).
function serializeSession(id, s) {
  return {
    id,
    repo: s.repo || '',                // the project folder this session belongs to
    firstPrompt: s.firstPrompt || '',
    name: s.name || '',
    archived: !!s.archived,
    state: persistedState(s.state),
    model: s.model || '',              // per-session agent model choice (ANTHROPIC_MODEL)
    subagentModel: s.subagentModel || '', // and the subagent model (CLAUDE_CODE_SUBAGENT_MODEL)
    // Where Claude Code keeps this session's conversation. Only a hook payload ever
    // names it, and none fires for an archived session — so without this, restoring
    // the app would leave its chat unreadable until it was resumed.
    transcript: s.transcript || '',
    edits: [...s.edits.entries()],     // [ [absPath, op[]], ... ]
    fileOps: [...s.fileOps.entries()], // [ [absPath, 'add'|'delete'], ... ]
  };
}

// Rebuild an in-memory session entry from a snapshot. A restored session has no
// live Claude process yet (pty: null, suspended: true) — it resumes under the same
// id when the user selects/restores it — but its tracked-file state is intact, so
// it stays committable immediately.
function deserializeSession(obj) {
  return {
    pty: null,
    repo: obj.repo || '',
    edits: new Map(Array.isArray(obj.edits) ? obj.edits : []),
    fileOps: new Map(Array.isArray(obj.fileOps) ? obj.fileOps : []),
    preStatus: null,
    firstPrompt: obj.firstPrompt || '',
    name: obj.name || '',
    archived: !!obj.archived,
    model: obj.model || '',
    subagentModel: obj.subagentModel || '',
    transcript: obj.transcript || '',
    // A restored session's process is gone, so a `working` state on disk reopens as
    // `interrupted`; a snapshot predating this field has no state and reopens idle.
    state: persistedState(obj.state),
    suspended: true,
  };
}

// Whether a session is worth keeping across restarts. A session has something to
// restore only once it carries a conversation (`firstPrompt`, set on the first
// prompt) or tracked work (`edits`/`fileOps`). An "empty" session — created but
// never prompted — has no transcript on disk, so resuming it would run
// `claude --resume <id>` against a conversation that was never created and surface
// "No conversation found with session ID: <id>". Such husks are never written and
// are dropped on load, so they can't resurrect on the next launch. Accepts the live
// entry (Maps) or a snapshot (arrays) for edits/fileOps.
function sizeOf(x) {
  return x instanceof Map ? x.size : (Array.isArray(x) ? x.length : 0);
}
function isSessionPersistable(s) {
  return !!(s && (s.firstPrompt || sizeOf(s.edits) || sizeOf(s.fileOps)));
}

// Approximate on-disk footprint of one serialized session, in bytes.
function sessionBytes(serialized) {
  return Buffer.byteLength(JSON.stringify(serialized));
}

// Given serialized sessions oldest-first, drop the oldest *evictable* ones until
// the total fits maxBytes. A session with a live PTY (one the user is actively
// using) is not evictable, so an over-budget run never yanks a running session out
// from under the user — it evicts old, idle/archived ones first. Returns the ids
// to evict (callers remove them from memory, disk, and the UI).
function enforceLimit(entries, maxBytes = MAX_PERSIST_BYTES) {
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const evictedIds = [];
  for (const e of entries) {
    if (total <= maxBytes) break;
    if (!e.evictable) continue;
    evictedIds.push(e.id);
    total -= e.bytes;
  }
  return { evictedIds, totalBytes: total };
}

module.exports = { MAX_PERSIST_BYTES, persistedState, serializeSession, deserializeSession, isSessionPersistable, sessionBytes, enforceLimit };
