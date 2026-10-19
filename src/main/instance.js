const { app, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { staleInstanceDirs, browserProfileStrategy, persistentBrowserEntries } = require('./instance-lib');

// Multiple instances must be able to run side by side. Two instances sharing one
// userData dir fight over the Chromium disk cache / singleton lock ("Unable to
// move the cache: Access is denied"), which is why a single-instance lock used to
// be required. Instead, give every instance its own throwaway profile dir so they
// never collide.
//
// Dev runs and the installed build must never share state: Electron's default
// userData is `%APPDATA%\<name>` for both, so without this a dev window and the
// packaged exe would fight over the same Chromium cache and — worse — share
// remote-config.json (the relay room id) and the paired-device / instance
// registries, letting a phone paired with the built app land on a dev window.
// Redirect unpackaged runs to a `-dev` sibling dir before anything reads a path.
if (!app.isPackaged) app.setPath('userData', app.getPath('userData') + '-dev');

// `sharedDataDir` is the default userData location, captured *before* the
// redirect. Persistent app config (e.g. last-folder) lives here so it survives
// restarts and is common to all instances; the per-instance profile holds only
// the disposable Chromium cache.
const sharedDataDir = app.getPath('userData');

// This instance's identity on the wire. A phone pairs with the *machine* but drives
// one window, so every remote surface that has to name a window uses this id: the
// relay keys a room's desktops by it (server/relay.js), and instance-registry.js
// publishes it so a phone can list every window and pick one.
//
// Not the pid: pids are reused, and the id has to be unique across the machine's
// history for as long as a phone might still be holding it. `startedAt` is what the
// phone sorts that list by.
const instanceId = crypto.randomUUID();
const startedAt = Date.now();

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
// (disposable) userData dir — so they'd be wiped on every quit. They are kept in
// a shared, persistent `browser-profile` dir instead, by one of two strategies
// (see browserProfileStrategy for why they differ):
// - link (Windows): the partition dir is a directory junction to the shared dir,
//   so Chromium reads and writes the shared profile directly. Concurrent
//   instances share this one partition's storage; an accepted trade-off (the
//   inline browser is rarely driven from two windows at once).
// - copy (macOS/Linux): the shared profile minus its caches is copied into a
//   real partition dir before Chromium opens it, and copied back out on quit.
//   Last instance to quit wins, as with Local Storage below.
const browserPartitionDir = path.join(instanceDir, 'Partitions', 'browser');
const browserProfileDir = path.join(sharedDataDir, 'browser-profile');
const browserStrategy = browserProfileStrategy(process.platform);
try {
  fs.mkdirSync(browserProfileDir, { recursive: true });
  fs.mkdirSync(path.dirname(browserPartitionDir), { recursive: true });
  if (browserStrategy === 'link') {
    fs.symlinkSync(browserProfileDir, browserPartitionDir, 'junction');
  } else {
    copyBrowserEntries(browserProfileDir, browserPartitionDir);
  }
} catch {}

function copyBrowserEntries(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const name of persistentBrowserEntries(fs.readdirSync(fromDir))) {
    fs.cpSync(path.join(fromDir, name), path.join(toDir, name), { recursive: true, force: true });
  }
}

// Chromium commits cookie changes to the Cookies database lazily (~30s batches),
// so a login made just before quitting would be missing from the copy taken on
// quit. Flush shortly after any change instead.
const COOKIE_FLUSH_DELAY_MS = 500;
if (browserStrategy === 'copy') {
  app.whenReady().then(() => {
    const browserSession = session.fromPartition('persist:browser');
    let flushTimer = null;
    browserSession.cookies.on('changed', () => {
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => browserSession.cookies.flushStore().catch(() => {}), COOKIE_FLUSH_DELAY_MS);
    });
  });
}

// Copy strategy only: write the live partition back to the shared profile,
// staged like persistLocalStorage so a failed copy never half-writes it.
function persistBrowserProfile() {
  if (browserStrategy !== 'copy' || !fs.existsSync(browserPartitionDir)) return;
  const tmp = browserProfileDir + '.tmp';
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    copyBrowserEntries(browserPartitionDir, tmp);
    fs.rmSync(browserProfileDir, { recursive: true, force: true });
    fs.renameSync(tmp, browserProfileDir);
  } catch {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

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
// to the shared snapshot (and, with the copy strategy, the browser profile), then
// remove the browser junction before the recursive delete (a delete that followed
// it into the shared dir would wipe the logins it exists to protect; rmdir removes
// the junction's reparse point only, never the target's contents).
app.on('quit', () => {
  persistLocalStorage();
  persistBrowserProfile();
  if (browserStrategy === 'link') { try { fs.rmdirSync(browserPartitionDir); } catch {} }
  try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}
});

module.exports = { sharedDataDir, instanceId, startedAt };
