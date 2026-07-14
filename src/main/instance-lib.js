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

// The instances a phone may pick from, oldest first. Same liveness rule as the dir
// sweep, for the same reason: an instance killed or crashed never gets to remove its
// own entry, so the file always holds leftovers and a reader has to prune them.
//
// Oldest-first because the phone lists windows by when they opened, and that order
// must not depend on which instance happened to serve the request.
function liveInstances(entries, isAlive) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.id === 'string' && Number.isInteger(e.pid) && isAlive(e.pid))
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// Replace one instance's entry, keyed by id, leaving every sibling's untouched.
// Callers read-modify-write the shared file with this rather than saving a list they
// have held in memory, which would be missing whatever a sibling added meanwhile.
function upsertInstance(entries, entry) {
  return [...(Array.isArray(entries) ? entries : []).filter((e) => e && e.id !== entry.id), entry];
}

module.exports = { staleInstanceDirs, liveInstances, upsertInstance };
