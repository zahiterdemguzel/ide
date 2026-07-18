// Electron-free helpers for instance.js's per-instance profile dirs. Kept pure
// so the stale-dir sweep is unit-testable without a real userData tree or live
// processes (see docs/platform-notes.md "GPU disk-cache errors").

// A leftover `instances/<pid>` dir is stale when no live process owns that pid.
// Given the dir names under `instances/` and an `isAlive(pid)` predicate, return
// the subset safe to delete: numeric pids with no living owner. A dir whose pid
// is still alive belongs to a running sibling instance and is left untouched, so
// the sweep never disturbs a concurrent instance. Non-numeric entries (e.g. a
// stray file) are ignored.
function staleInstanceDirs(names, isAlive) {
  return names.filter((name) => /^\d+$/.test(name) && !isAlive(Number(name)));
}

// How long an entry may go unrefreshed before a reader treats it as dead. A live
// instance rewrites `seenAt` every HEARTBEAT_MS, so this allows a few missed beats
// (a busy main process, a suspended laptop) before its window drops off the phone's
// list — it comes back on the next beat.
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = HEARTBEAT_MS * 4;

// The instances a phone may pick from, oldest first. An instance killed or crashed
// never gets to remove its own entry, so the file always holds leftovers and a reader
// has to prune them.
//
// Liveness is `seenAt` freshness, NOT just an alive pid. Pid alone lies: it is dead
// instances that leave entries behind, and the OS — Windows especially — hands their
// pid to some unrelated process soon after, which then reads as alive and keeps a
// phantom window in the phone's list for good. Dev runs hit this constantly, because
// restarting the app kills it without the quit handler that would deregister it. The
// pid check is kept as a cheap first pass: it catches a dead instance immediately,
// before its heartbeat has had time to go stale.
//
// An entry with no `seenAt` was written by a build that never heartbeat; treat it as
// stale rather than trust it forever — a still-running window republishes within a
// beat anyway.
//
// Oldest-first because the phone lists windows by when they opened, and that order
// must not depend on which instance happened to serve the request.
function liveInstances(entries, isAlive, now = Date.now()) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.id === 'string' && Number.isInteger(e.pid) && isAlive(e.pid))
    .filter((e) => Number.isFinite(e.seenAt) && now - e.seenAt < STALE_AFTER_MS)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Replace one instance's entry, keyed by id, leaving every sibling's untouched.
// Callers read-modify-write the shared file with this rather than saving a list they
// have held in memory, which would be missing whatever a sibling added meanwhile.
function upsertInstance(entries, entry) {
  return [...(Array.isArray(entries) ? entries : []).filter((e) => e && e.id !== entry.id), entry];
}

module.exports = { staleInstanceDirs, liveInstances, upsertInstance, HEARTBEAT_MS, STALE_AFTER_MS };
