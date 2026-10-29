const { ipcRenderer } = require('electron');

// Restore the persisted settings file into localStorage before any page script
// runs (main/settings-store.js). The preload shares the page's storage area, and
// running here — ahead of the renderer's modules — is what lets modules that read
// localStorage at import time see the saved values. The file is authoritative, so
// the restore is exact: a key removed in another window stays removed here.
function restoreSettings() {
  let saved = null;
  try { saved = ipcRenderer.sendSync('settings-store-snapshot'); } catch {}
  if (!saved) return; // no file yet — the renderer seeds it from current storage
  try {
    globalThis.localStorage.clear();
    for (const [key, value] of Object.entries(saved)) globalThis.localStorage.setItem(key, value);
  } catch (err) {
    console.error('[settings restore]', err);
  }
}
restoreSettings();

module.exports = {
  settingsStoreChanges: (changes) => ipcRenderer.send('settings-store-changes', changes),
  settingsStoreSeed: (all) => ipcRenderer.send('settings-store-seed', all),
};
