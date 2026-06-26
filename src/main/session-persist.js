// Pure (Electron-free) logic for persisting sessions across app restarts: turn an
// in-memory session entry into a JSON-safe snapshot and back, measure its size,
// and enforce the on-disk budget by evicting the oldest sessions. The fs/IPC glue
// lives in sessions.js; everything here is plain data so it stays unit-testable.

// The most we keep on disk for previous sessions and their tracking data. Once the
// snapshot would exceed this, the oldest evictable sessions are dropped (see
// enforceLimit) until it fits.
const MAX_PERSIST_BYTES = 100 * 1024 * 1024; // 100 MB

// Snapshot one live session entry to a plain object. The PTY and the transient
// pre-tool git-status snapshot are runtime-only and deliberately omitted; the Maps
// become arrays so JSON.stringify can round-trip them. `archived` records the UI
// tab the session belongs to (an archived session restores into the Archived tab).
function serializeSession(id, s) {
  return {
    id,
    firstPrompt: s.firstPrompt || '',
    name: s.name || '',
    archived: !!s.archived,
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
    edits: new Map(Array.isArray(obj.edits) ? obj.edits : []),
    fileOps: new Map(Array.isArray(obj.fileOps) ? obj.fileOps : []),
    preStatus: null,
    firstPrompt: obj.firstPrompt || '',
    name: obj.name || '',
    archived: !!obj.archived,
    suspended: true,
  };
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

module.exports = { MAX_PERSIST_BYTES, serializeSession, deserializeSession, sessionBytes, enforceLimit };
