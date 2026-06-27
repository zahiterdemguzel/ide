const { ipcRenderer } = require('electron');

// Per-session Claude PTYs + the per-session commit/revert + name/meta streams.
module.exports = {
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  newSession: (size) => ipcRenderer.invoke('new-session', size),
  suspendSession: (id) => ipcRenderer.send('suspend-session', { id }),
  resumeSession: (id, { cols, rows }) => ipcRenderer.invoke('resume-session', { id, cols, rows }),
  killSession: (id) => ipcRenderer.send('kill-session', { id }),
  sendInput: (id, data) => ipcRenderer.send('pty-input', { id, data }),
  resize: (id, cols, rows) => ipcRenderer.send('pty-resize', { id, cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, msg) => cb(msg)),
  commitSession: (id) => ipcRenderer.invoke('commit-session', id),
  revertSession: (id) => ipcRenderer.invoke('revert-session', id),
  sessionDiff: (id) => ipcRenderer.invoke('session-diff', id),
  sessionDiffStat: (id) => ipcRenderer.invoke('session-diff-stat', id),
  onSessionMeta: (cb) => ipcRenderer.on('session-meta', (_e, msg) => cb(msg)),
  onSessionName: (cb) => ipcRenderer.on('session-name', (_e, msg) => cb(msg)),
  onSessionEvicted: (cb) => ipcRenderer.on('session-evicted', (_e, msg) => cb(msg)),
};
