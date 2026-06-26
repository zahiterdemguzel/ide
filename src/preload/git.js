const { ipcRenderer } = require('electron');

// The shared repo: folder picker + git porcelain for the git pane.
module.exports = {
  getRepoPath: () => ipcRenderer.invoke('get-repo-path'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  openFolderPath: (dir) => ipcRenderer.invoke('open-folder-path', dir),
  getRecentFolders: () => ipcRenderer.invoke('get-recent-folders'),
  setWindowTitle: (repoPath) => ipcRenderer.invoke('set-window-title', repoPath),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  gitBranches: () => ipcRenderer.invoke('git-branches'),
  gitCheckout: (branch) => ipcRenderer.invoke('git-checkout', branch),
  gitCreateBranch: (branch) => ipcRenderer.invoke('git-create-branch', branch),
  gitStage: (file) => ipcRenderer.invoke('git-stage', file),
  gitUnstage: (file) => ipcRenderer.invoke('git-unstage', file),
  gitDiff: (args) => ipcRenderer.invoke('git-diff', args),
  gitRevert: (args) => ipcRenderer.invoke('git-revert', args),
  gitCommit: (msg) => ipcRenderer.invoke('git-commit', msg),
  gitUndo: () => ipcRenderer.invoke('git-undo'),
  gitPush: () => ipcRenderer.invoke('git-push'),
  gitFetch: () => ipcRenderer.invoke('git-fetch'),
  gitPull: () => ipcRenderer.invoke('git-pull'),
  gitLog: () => ipcRenderer.invoke('git-log'),
  gitCommitDiff: (hash) => ipcRenderer.invoke('git-commit-diff', hash),
  gitRevertCommit: (hash) => ipcRenderer.invoke('git-revert-commit', hash),
};
