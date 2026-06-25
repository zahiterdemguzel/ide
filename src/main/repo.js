const { ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getWin, setWindowTitle } = require('./window');
const { sharedDataDir } = require('./instance');

// Restore the last opened folder; fall back to cwd on first run / bad path.
// Kept in the shared data dir (not the per-instance profile) so it persists
// across runs and is common to every instance.
const lastFolderFile = path.join(sharedDataDir, 'last-folder.txt');
function loadLastFolder() {
  try {
    const p = fs.readFileSync(lastFolderFile, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.cwd();
}

let repoPath = loadLastFolder();
const getRepoPath = () => repoPath;

// Subsystems that derive state from the open folder (e.g. the run-config watcher)
// register here so they re-point when the user opens a different repo.
const repoChangeListeners = [];
const onRepoChange = (fn) => repoChangeListeners.push(fn);

function setRepoPath(p) {
  repoPath = p;
  try { fs.writeFileSync(lastFolderFile, repoPath); } catch {}
  for (const fn of repoChangeListeners) { try { fn(repoPath); } catch (err) { console.error('[repo-change listener]', err); } }
}

// Resolve the git repo root for a chosen dir so porcelain paths and add/reset
// line up no matter which subfolder the user picked. Falls back to the dir itself.
function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return out.trim() || dir;
  } catch { return dir; }
}

ipcMain.handle('get-repo-path', () => repoPath);

ipcMain.handle('open-folder', async () => {
  try {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    setRepoPath(repoRoot(r.filePaths[0]));
    return { canceled: false, repo: repoPath };
  } catch (err) {
    console.error('[open-folder failed]', err);
    return { canceled: true, error: String(err) };
  }
});

// The renderer drives the title (on startup via refreshGit, and on Open folder)
// since it already has the repo path in hand.
ipcMain.handle('set-window-title', (_e, folderPath) => setWindowTitle(folderPath || repoPath));

module.exports = { getRepoPath, setRepoPath, repoRoot, onRepoChange };
