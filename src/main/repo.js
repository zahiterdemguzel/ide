const { ipcMain, dialog } = require('electron');
// Channels a paired mobile client may call go through the remote bridge
// (registers with ipcMain AND the remote registry). Desktop-only channels
// (native dialog, window title) stay on raw ipcMain.
const { handle } = require('./remote-bridge');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { getWin, setWindowTitle, sendToRenderer } = require('./window');
const { sharedDataDir } = require('./instance');
const { addRecent, removeRecent } = require('./recent-folders');
const { parseFolderArg } = require('./cli-args');
const { refreshNativeRecent } = require('./native-recent');

// Recently opened folders for the Open-folder reverse-combobox, most recent
// first. Kept in the shared data dir so it persists across runs and instances.
const recentFoldersFile = path.join(sharedDataDir, 'recent-folders.json');
function loadRecentFolders() {
  try {
    const list = JSON.parse(fs.readFileSync(recentFoldersFile, 'utf8'));
    if (Array.isArray(list)) return list.filter((p) => typeof p === 'string' && p);
  } catch {}
  return [];
}
let recentFolders = loadRecentFolders();
const getRecentFolders = () => recentFolders;

// A `--folder <path>` CLI override wins over the persisted last folder, so a
// launched instance can open a specific directory (e.g. a throwaway test
// workspace) — it's applied to the initial repoPath directly and never written
// back to the recent list.
function cliFolder() {
  const p = parseFolderArg(process.argv);
  if (!p) return null;
  if (fs.existsSync(p)) return path.resolve(p);
  console.error('[cli folder not found, ignoring]', p);
  return null;
}

// No project opens by default: repoPath stays null until the user picks one from
// the recent-projects menu (auto-opened on launch) or browses. A `--folder` CLI
// flag is the only way to start with a folder already open.
let repoPath = cliFolder();

// The tree everything OPERATES on: the project itself, or one of its worktrees
// while a worktree session is selected. `repoPath` stays the project the user
// opened — it's what the recent list, the window title and the session-list
// filter mean by "this project", and a worktree must never take its place.
let activeWorktree = null;
const getMainRepoPath = () => repoPath;
const getRepoPath = () => activeWorktree || repoPath;
const getActiveWorktree = () => activeWorktree;

// Seed the OS-native recent menus (Windows Jump List / macOS Dock menu). The
// refresh is ready-gated, so this pre-`ready` call is safely deferred.
refreshNativeRecent(recentFolders, openRecentInPlace);

// Subsystems that derive state from the open folder (e.g. the run-config watcher)
// register here so they re-point when the user opens a different repo.
const repoChangeListeners = [];
const onRepoChange = (fn) => repoChangeListeners.push(fn);

// Bumped on every switch. The renderer drops a `folder-changed` payload older
// than the newest it has seen, so a slow refresh from an earlier switch can't
// paint over a newer tree — worktree focus-follow can fire these back to back.
let repoEpoch = 0;

function notifyRepoChange() {
  repoEpoch++;
  const active = getRepoPath();
  for (const fn of repoChangeListeners) { try { fn(active); } catch (err) { console.error('[repo-change listener]', err); } }
  // Every open path lands here — dialog, recent menu, dock, remote — so this is the
  // one place that tells paired phones (and the renderer, for switches it didn't
  // initiate). The renderer's own opens just re-apply the same repo; harmless.
  sendToRenderer('folder-changed', { repo: active, main: repoPath, worktree: activeWorktree, epoch: repoEpoch });
}

function setRepoPath(p) {
  repoPath = p;
  // Opening a project always leaves worktree mode: the old project's worktrees
  // mean nothing here, and leaving one active would point every panel at a tree
  // outside the folder the user just opened.
  activeWorktree = null;
  recentFolders = addRecent(recentFolders, repoPath);
  try { fs.writeFileSync(recentFoldersFile, JSON.stringify(recentFolders)); } catch {}
  refreshNativeRecent(recentFolders, openRecentInPlace);
  notifyRepoChange();
}

// Point the active tree at one of the open project's worktrees, or back at the
// project itself with `null`. Deliberately never touches the recent list: a
// worktree is not a project the user opened, and it must never become the folder
// the app reopens next launch. Idempotent, so clicking through sessions that
// share a tree costs nothing.
function setActiveWorktree(p) {
  const next = p || null;
  if (next === activeWorktree) return false;
  activeWorktree = next;
  notifyRepoChange();
  return true;
}

// Resolve the git repo root for a chosen dir so porcelain paths and add/reset
// line up no matter which subfolder the user picked. Falls back to the dir itself.
function repoRoot(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' },
      (err, stdout) => resolve((!err && stdout.trim()) || dir));
  });
}

handle('get-repo-path', () => getRepoPath());
// The project itself, whatever worktree is active. Session identity, per-project
// settings and the session-list filter all key on this, never on the active tree.
handle('get-main-repo-path', () => repoPath);
handle('get-recent-folders', () => recentFolders);

ipcMain.handle('open-folder', async () => {
  try {
    const r = await dialog.showOpenDialog(getWin(), { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    setRepoPath(await repoRoot(r.filePaths[0]));
    return { canceled: false, repo: repoPath };
  } catch (err) {
    console.error('[open-folder failed]', err);
    return { canceled: true, error: String(err) };
  }
});

// Switch to a folder chosen from a recent list. Drop it from the list if it no
// longer exists so stale entries don't linger. Shared by the renderer's recent
// menu (via IPC) and the macOS Dock menu (in place).
async function switchToFolder(dir) {
  try {
    if (typeof dir !== 'string' || !fs.existsSync(dir)) {
      recentFolders = recentFolders.filter((p) => p !== dir);
      try { fs.writeFileSync(recentFoldersFile, JSON.stringify(recentFolders)); } catch {}
      refreshNativeRecent(recentFolders, openRecentInPlace);
      return { canceled: true, error: 'missing' };
    }
    setRepoPath(await repoRoot(dir));
    return { canceled: false, repo: repoPath };
  } catch (err) {
    console.error('[switch folder failed]', err);
    return { canceled: true, error: String(err) };
  }
}

handle('open-folder-path', (_e, dir) => switchToFolder(dir));

// Forget a folder the user removed from the recent list. Persists and re-seeds
// the OS-native recent menus; returns the trimmed list so the renderer can re-render.
function removeRecentFolder(dir) {
  recentFolders = removeRecent(recentFolders, dir);
  try { fs.writeFileSync(recentFoldersFile, JSON.stringify(recentFolders)); } catch {}
  refreshNativeRecent(recentFolders, openRecentInPlace);
  return recentFolders;
}

handle('remove-recent-folder', (_e, dir) => removeRecentFolder(dir));

// macOS Dock menu pick: switch the running app's folder and tell the renderer to
// reload everything that depends on it, mirroring the in-app Open-folder flow.
// (The Windows Jump List can't message a running instance, so it relaunches the
// exe with `--folder` instead — see native-recent.js.)
async function openRecentInPlace(dir) {
  await switchToFolder(dir);
}

// The renderer drives the title (on startup via refreshGit, and on Open folder),
// but it does not get to choose what the title says: it always names the opened
// PROJECT. The renderer's callers pass whatever tree they happen to be showing,
// which for a worktree session is an opaque `sess-xxxx` directory -- the window
// title is not where the active tree belongs (the pane-header tint is).
ipcMain.handle('set-window-title', () => setWindowTitle(repoPath));

module.exports = { getRepoPath, getMainRepoPath, getActiveWorktree, setActiveWorktree, getRecentFolders, setRepoPath, repoRoot, onRepoChange };
