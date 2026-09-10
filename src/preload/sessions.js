const { ipcRenderer } = require('electron');

// Per-session Claude PTYs + the per-session commit/revert + name/meta streams.
module.exports = {
  checkClaude: () => ipcRenderer.invoke('check-claude'),
  checkCodex: () => ipcRenderer.invoke('check-codex'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  setStatusLineEnabled: (on) => ipcRenderer.send('set-statusline-enabled', on),
  notifySessionFinished: (payload) => ipcRenderer.send('notify-session-finished', payload),
  onSelectSession: (cb) => ipcRenderer.on('select-session', (_e, id) => cb(id)),
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  newSession: (size) => ipcRenderer.invoke('new-session', size),
  setSessionModel: (id, model) => ipcRenderer.send('set-session-model', { id, model }),
  setSessionEffort: (id, effort) => ipcRenderer.send('set-session-effort', { id, effort }),
  suspendSession: (id) => ipcRenderer.send('suspend-session', { id }),
  resumeSession: (id, { cols, rows }) => ipcRenderer.invoke('resume-session', { id, cols, rows }),
  killSession: (id) => ipcRenderer.send('kill-session', { id }),
  // Worktree sessions: closing one decides the fate of its checkout, so unlike
  // killSession this awaits an outcome ('unmerged' asks the user what to do).
  closeSession: (id, force) => ipcRenderer.invoke('close-session', { id, force }),
  mergeSession: (id) => ipcRenderer.invoke('merge-session', id),
  focusSessionRepo: (id) => ipcRenderer.invoke('focus-session-repo', id),
  focusMainRepo: () => ipcRenderer.invoke('focus-main-repo'),
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
  onSessionModel: (cb) => ipcRenderer.on('session-model', (_e, msg) => cb(msg)),
  onSessionEffort: (cb) => ipcRenderer.on('session-effort', (_e, msg) => cb(msg)),
  onSessionEvicted: (cb) => ipcRenderer.on('session-evicted', (_e, msg) => cb(msg)),
  onSessionsChanged: (cb) => ipcRenderer.on('sessions-changed', (_e, list) => cb(list)),
  onSessionError: (cb) => ipcRenderer.on('session-error', (_e, msg) => cb(msg)),
};
