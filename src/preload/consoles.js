const { ipcRenderer } = require('electron');

// Git-pane terminal tabs (interactive shell PTYs, independent of session PTYs).
module.exports = {
  termShells: () => ipcRenderer.invoke('term-shells'),
  termCreate: (opts) => ipcRenderer.invoke('term-create', opts),
  termRestart: (opts) => ipcRenderer.invoke('term-restart', opts),
  termInput: (id, data) => ipcRenderer.send('term-input', { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.send('term-resize', { id, cols, rows }),
  termKill: (id) => ipcRenderer.send('term-kill', { id }),
  onTermData: (cb) => ipcRenderer.on('term-data', (_e, msg) => cb(msg)),
  onTermExit: (cb) => ipcRenderer.on('term-exit', (_e, msg) => cb(msg)),
};
