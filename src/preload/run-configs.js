const { ipcRenderer } = require('electron');

// VS Code launch.json / tasks.json run toolbar.
module.exports = {
  getRunConfigs: () => ipcRenderer.invoke('get-run-configs'),
  runConfig: (args) => ipcRenderer.invoke('run-config', args),
  onRunConfigsChanged: (cb) => ipcRenderer.on('run-configs-changed', () => cb()),
};
