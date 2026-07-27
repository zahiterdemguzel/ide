const { ipcRenderer } = require('electron');

// VS Code launch.json / tasks.json run toolbar.
module.exports = {
  getRunConfigs: () => ipcRenderer.invoke('get-run-configs'),
  runConfig: (args) => ipcRenderer.invoke('run-config', args),
  // Tasks the folder asks to start on open (`runOptions.runOn: "folderOpen"`).
  // Returned rather than run, so the renderer can ask before executing them.
  getAutoTasks: () => ipcRenderer.invoke('get-auto-tasks'),
  onRunConfigsChanged: (cb) => ipcRenderer.on('run-configs-changed', () => cb()),
  // A phone ran a config: main pushes the resolved specs for us to open as tabs.
  onRunSpecs: (cb) => ipcRenderer.on('run-specs', (_e, msg) => cb(msg)),
};
