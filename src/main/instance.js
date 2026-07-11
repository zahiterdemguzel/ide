const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { staleInstanceDirs } = require('./instance-lib');

// Multiple instances must be able to run side by side. Two instances sharing one
// userData dir fight over the Chromium disk cache / singleton lock ("Unable to
// move the cache: Access is denied"), which is why a single-instance lock used to
// be required. Instead, give every instance its own throwaway profile dir so they
// never collide.
//
// `sharedDataDir` is the default userData location, captured *before* the
// redirect. Persistent app config (e.g. last-folder) lives here so it survives
// restarts and is common to all instances; the per-instance profile holds only
// the disposable Chromium cache.
const sharedDataDir = app.getPath('userData');

const instancesRoot = path.join(sharedDataDir, 'instances');
const instanceDir = path.join(instancesRoot, String(process.pid));

// Windows reuses pids, and the on-quit cleanup below can't fire on a crash/kill
// (and even on a clean quit rmSync fails on a cache file something still holds),
// so leftover `instances/<pid>` dirs accumulate. When a new instance is handed a
// pid whose stale dir is still on disk, Chromium finds an old, version-mismatched
// cache there and tries to move it aside to recreate it — which fails with
// "Unable to move the cache: Access is denied" if anything still has a handle on
// it. This is most likely when the app is launched from inside the app itself,
// where the parent has just churned through many pids spawning PTYs and the
// `claude` CLI, so a fresh Electron pid is far more likely to hit a leftover dir.
//
// Two best-effort defenses run before the userData redirect:
// 1. Drop our own pid's leftover dir, so we always start from a clean cache. The
//    predecessor that created it is gone (we hold its pid now), so nothing should
//    still be locking it.
try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}

// 2. Sweep every other leftover dir whose pid no longer belongs to a running
//    process — self-healing the pile-up. A dir owned by a live sibling instance
//    has an alive pid (and locked files), so it's skipped: the sweep never
//    disturbs a running instance. A pid reused by some unrelated process reads as
//    alive too, so we simply leave that dir for the next run rather than risk it.
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
try {
  for (const name of staleInstanceDirs(fs.readdirSync(instancesRoot), isAlive)) {
    try { fs.rmSync(path.join(instancesRoot, name), { recursive: true, force: true }); } catch {}
  }
} catch {}

app.setPath('userData', instanceDir);

// The inline browser must stay logged in across restarts, but its cookies /
// localStorage live in the `persist:browser` partition under the per-instance
// (disposable) userData dir — so they'd be wiped on every quit. Redirect just
// that one partition's on-disk folder to a shared, persistent location via a
// directory junction (symlink on macOS/Linux). Chromium then reads and writes
// the browser profile in the shared dir, so logins survive restarts and are
// common to all instances, while the rest of the profile (cache, default
// session) stays per-instance and disposable. Concurrent instances share this
// one partition's storage; that's an accepted trade-off (the inline browser is
// rarely driven from two windows at once).
const browserPartitionLink = path.join(instanceDir, 'Partitions', 'browser');
const browserProfileDir = path.join(sharedDataDir, 'browser-profile');
try {
  fs.mkdirSync(browserProfileDir, { recursive: true });
  fs.mkdirSync(path.dirname(browserPartitionLink), { recursive: true });
  fs.symlinkSync(browserProfileDir, browserPartitionLink, 'junction');
} catch {}

// The renderer's app settings (theme, locale, panel visibility, agent-model
// defaults, etc. — see docs/settings.md) are plain `localStorage`, which
// Chromium backs with a `Local Storage` LevelDB folder in the *default*
// session, i.e. directly under userData. Left alone, every setting would reset
// on each restart (the per-instance profile is disposable).
//
// This used to be a junction to one shared folder, but LevelDB allows a single
// live process: with any sibling instance running, the new instance's storage
// service spent ~5.5s waiting on the shared database's lock before giving up —
// the renderer's first localStorage read blocks module evaluation, so that was
// 5.5s of blank window on every extra instance. Instead, COPY the shared
// snapshot into the per-instance profile on launch (before Chromium opens it)
// and copy it back out on quit. Each instance runs on its own private copy —
// no lock contention, instant startup. Concurrent instances no longer see each
// other's mid-session setting changes and the last instance to quit wins,
// which is the same accepted trade-off the junction already made (last writer
// won there too).
const localStorageLive = path.join(instanceDir, 'Local Storage');
const localStorageDir = path.join(sharedDataDir, 'local-storage');
try {
  if (fs.existsSync(localStorageDir)) {
    fs.mkdirSync(instanceDir, { recursive: true });
    fs.cpSync(localStorageDir, localStorageLive, { recursive: true, force: true });
  }
} catch {}

// Persist the live settings back to the shared snapshot. Staged via a temp dir +
// rename so a copy that fails midway (a file still locked by a lingering storage
// flush) can never leave the shared snapshot half-written — a LevelDB folder
// mixing files from two generations reads as corrupt and would drop every setting.
function persistLocalStorage() {
  if (!fs.existsSync(localStorageLive)) return;
  const tmp = localStorageDir + '.tmp';
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(localStorageLive, tmp, { recursive: true });
    fs.rmSync(localStorageDir, { recursive: true, force: true });
    fs.renameSync(tmp, localStorageDir);
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// The per-instance profile is disposable — drop it when this instance exits so
// the dirs don't pile up across runs. First persist the live Local Storage back
// to the shared snapshot, then remove the browser junction before the recursive
// delete (a delete that followed it into the shared dir would wipe the logins it
// exists to protect; rmdir removes the junction's reparse point only, never the
// target's contents).
app.on('quit', () => {
  persistLocalStorage();
  try { fs.rmdirSync(browserPartitionLink); } catch {}
  try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}
});

module.exports = { sharedDataDir };
