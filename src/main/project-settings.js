const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');
const { sanitizeMap, projectSettings, withProjectSetting } = require('./project-settings-lib');

// Settings scoped to a project folder (not the app), kept in the shared data dir
// so they're the same for every instance and survive restarts — like
// recent-folders.json and interpreters.json. The pure map handling lives in
// project-settings-lib.js.
//
// Deliberately NOT in renderer localStorage: main reads useWorktrees while
// creating a session, before any renderer round-trip, and localStorage is
// snapshot-copied per instance (last instance to quit wins — see instance.js).
const STORE_PATH = path.join(sharedDataDir, 'project-settings.json');

function load() {
  try { return sanitizeMap(JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))); }
  catch { return {}; }
}

let settings = load();

function save() {
  try {
    fs.mkdirSync(sharedDataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(settings, null, 2));
  } catch (e) { console.error('[project-settings] save failed:', e); }
}

// Read one project's settings (defaults filled in). Callers in main use this
// synchronously — it never touches disk after load.
const getProjectSettings = (repo) => projectSettings(settings, repo);

function setProjectSetting(repo, key, value) {
  settings = withProjectSetting(settings, repo, key, value);
  save();
  return projectSettings(settings, repo);
}

ipcMain.handle('get-project-settings', (_e, repo) => getProjectSettings(repo));
ipcMain.handle('set-project-setting', (_e, { repo, key, value } = {}) => setProjectSetting(repo, key, value));

module.exports = { getProjectSettings, setProjectSetting };
