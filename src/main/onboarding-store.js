const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');

// Onboarding flags (e.g. "the first-run tour has been shown") must survive app
// restarts. Renderer localStorage can't: the default session lives in the
// per-instance profile dir that is wiped on every quit (see instance.js), so a
// flag written there is gone next launch and the tour would re-run forever.
// Persist it in a small JSON file in the shared data dir instead — the same place
// last-folder / recent-folders live (repo.js), which is never deleted.
const file = path.join(sharedDataDir, 'onboarding.json');

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (o && typeof o === 'object') return o;
  } catch {}
  return {};
}

let state = load();

function save() {
  try { fs.writeFileSync(file, JSON.stringify(state)); } catch {}
}

ipcMain.handle('onboarding-get', () => state);
ipcMain.handle('onboarding-set-tour-done', () => { state.tourDone = true; save(); return state; });
ipcMain.handle('onboarding-reset', () => { state = {}; save(); return state; });
