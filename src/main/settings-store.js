const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');
const { writeFileAtomic } = require('./atomic-write');
const { normalizeStore, applyChanges } = require('./settings-store-lib');

// The renderer's app settings are plain localStorage, whose LevelDB lives in the
// disposable per-instance profile and is only copied back to the shared dir on a
// clean quit (instance.js) — a crash, force-kill or killed dev run lost every
// change made that run. So localStorage is mirrored into this JSON file instead:
// the renderer sends each write as it happens (shared/storage-sync.js) and the
// preload restores the file into localStorage before any page script reads it.
const file = path.join(sharedDataDir, 'settings.json');

// null when the file doesn't exist yet: the preload then leaves localStorage as
// the legacy LevelDB copy restored it, and the renderer seeds the file from that.
function readStore() {
  try { return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (err) { return err.code === 'ENOENT' ? null : {}; }
}

function writeStore(store) {
  try {
    fs.mkdirSync(sharedDataDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify(store));
  } catch (err) {
    console.error('[settings store save]', err);
  }
}

// Synchronous on purpose: the preload must restore settings before the page's
// modules evaluate, and several read localStorage at import time.
ipcMain.on('settings-store-snapshot', (event) => { event.returnValue = readStore(); });

// Re-read from disk on every batch so changes made by sibling instances since our
// last write are kept, not overwritten.
ipcMain.on('settings-store-changes', (_event, changes) => {
  writeStore(applyChanges(readStore() || {}, changes));
});

// First run after upgrading: adopt the existing localStorage as the starting file.
ipcMain.on('settings-store-seed', (_event, all) => {
  if (readStore() === null) writeStore(normalizeStore(all));
});
