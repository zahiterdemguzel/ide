const { ipcRenderer } = require('electron');

// The shared repo: folder picker + git porcelain for the git pane.
module.exports = {
  openFolder: () => ipcRenderer.invoke('open-folder'),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  gitStage: (file) => ipcRenderer.invoke('git-stage', file),
  gitUnstage: (file) => ipcRenderer.invoke('git-unstage', file),
  gitDiff: (args) => ipcRenderer.invoke('git-diff', args),
  gitRevert: (args) => ipcRenderer.invoke('git-revert', args),
  gitCommit: (msg) => ipcRenderer.invoke('git-commit', msg),
  gitUndo: () => ipcRenderer.invoke('git-undo'),
  gitPush: () => ipcRenderer.invoke('git-push'),
};
