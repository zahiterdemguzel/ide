const { ipcRenderer } = require('electron');

// The shared repo: folder picker + git porcelain for the git pane.
module.exports = {
  getRepoPath: () => ipcRenderer.invoke('get-repo-path'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  setWindowTitle: (repoPath) => ipcRenderer.invoke('set-window-title', repoPath),
  gitStatus: () => ipcRenderer.invoke('git-status'),
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
