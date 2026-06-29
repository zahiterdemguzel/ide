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

module.exports = { staleInstanceDirs };
