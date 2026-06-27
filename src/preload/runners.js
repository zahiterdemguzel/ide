const { ipcRenderer } = require('electron');

// Run a single source file with a detected/registered interpreter.
module.exports = {
  getRunnerLangs: () => ipcRenderer.invoke('get-runner-langs'),
  resolveRunner: (args) => ipcRenderer.invoke('resolve-runner', args),
  pickInterpreter: (args) => ipcRenderer.invoke('pick-interpreter', args),
  clearInterpreter: (args) => ipcRenderer.invoke('clear-interpreter', args),
};
