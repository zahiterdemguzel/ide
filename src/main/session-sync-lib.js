// Pure rules for keeping several running app instances in agreement about the
// shared session store. Every instance (a second window, a dev build) reads and
// writes the same `sessions/<id>.json` files, but each holds its own in-memory
// copy. Without these rules an instance only ever saw the files present at its
// launch, and on quit it rewrote all of them from that stale copy — which put an
// archived session back into Active and resurrected deleted ones, and left a
// paired phone (driving one instance) listing a different set than the desktop
// window in front of you (driving another).
// Electron-free so it's unit-tested on its own; the fs glue lives in sessions.js.

// What identifies one version of a session file on disk. Comparing it against the
// version this instance last wrote or read is how a file event is told apart from
// our own write's echo — far cheaper than keeping a copy of every file's text.
function fileStamp(stat) {
  return stat ? `${stat.mtimeMs}:${stat.size}` : null;
}

// How to react to a change seen on one session's file.
// - `local`: this instance's record ({ live }), or undefined when it has none.
// - `diskStamp`: the file's current stamp, or null when the file is gone.
// - `syncedStamp`: the stamp this instance last wrote or read (null/undefined when
//   it never saw the file).
// Returns 'ignore', 'adopt' (load the file over the local record, or as a new one)
// or 'drop' (forget the local record — another instance deleted it).
function planFileChange({ local, diskStamp, syncedStamp }) {
  if (diskStamp === (syncedStamp ?? null)) return 'ignore';
  // A session running here is owned by this instance: its record is the live truth,
  // and this instance's next write supersedes whatever another one stored.
  if (local && local.live) return 'ignore';
  if (diskStamp === null) return local ? 'drop' : 'ignore';
  return 'adopt';
}

// Which sessions a quitting instance writes. Every user action already saves its
// session the moment it happens, so quit only has to flush what is still in
// flight: debounced writes, and the sessions this instance runs (it owns them).
// Rewriting the rest would overwrite newer changes another instance made.
function idsToWriteOnQuit(entries) {
  return entries.filter((e) => e.live || e.pendingWrite).map((e) => e.id);
}

module.exports = { fileStamp, planFileChange, idsToWriteOnQuit };
