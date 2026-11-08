const { ipcRenderer } = require('electron');

// The Cmd+Q double-press guard: main asks the page to show "press again to quit".
module.exports = {
  onQuitWarning: (cb) => ipcRenderer.on('quit-warning', (_e, msg) => cb(msg)),
};
