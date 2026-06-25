const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { getWin } = require('./window');

// Restore the last opened folder; fall back to cwd on first run / bad path.
const lastFolderFile = path.join(app.getPath('userData'), 'last-folder.txt');
function loadLastFolder() {
  try {
    const p = fs.readFileSync(lastFolderFile, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.cwd();
}

let repoPath = loadLastFolder();
const getRepoPath = () => repoPath;
function setRepoPath(p) {
  repoPath = p;
  try { fs.writeFileSync(lastFolderFile, repoPath); } catch {}
}

// Resolve the git repo root for a chosen dir so porcelain paths and add/reset
// line up no matter which subfolder the user picked. Falls back to the dir itself.
function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return out.trim() || dir;
  } catch { return dir; }
}

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

module.exports = { getRepoPath, setRepoPath, repoRoot };
