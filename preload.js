const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  newSession: (size) => ipcRenderer.invoke('new-session', size),
  killSession: (id) => ipcRenderer.send('kill-session', { id }),
  sendInput: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  gitStatus: () => ipcRenderer.invoke('git-status'),
  gitStage: (file) => ipcRenderer.invoke('git-stage', file),
  gitUnstage: (file) => ipcRenderer.invoke('git-unstage', file),
  gitCommit: (msg) => ipcRenderer.invoke('git-commit', msg),
  gitPush: () => ipcRenderer.invoke('git-push'),
});
