const { ipcRenderer } = require('electron');

// Custom models (Ollama): status/setup, catalog search, install/uninstall, and
// the installed list that feeds the model dropdowns. Management is desktop-only;
// only `ollama-list` + the `ollama-models-changed` push are exposed to a paired
// phone (see server/protocol.js), so a phone can pick but not install.
module.exports = {
  ollamaStatus: () => ipcRenderer.invoke('ollama-status'),
  ollamaEnsure: () => ipcRenderer.invoke('ollama-ensure'),
  ollamaCatalog: (query) => ipcRenderer.invoke('ollama-catalog', query),
  ollamaList: () => ipcRenderer.invoke('ollama-list'),
  ollamaPull: (name) => ipcRenderer.invoke('ollama-pull', name),
  ollamaCancelPull: (name) => ipcRenderer.send('ollama-cancel-pull', name),
  ollamaRemove: (name) => ipcRenderer.invoke('ollama-remove', name),
  ollamaRemoveAll: () => ipcRenderer.invoke('ollama-remove-all'),
  onOllamaPullProgress: (cb) => ipcRenderer.on('ollama-pull-progress', (_e, msg) => cb(msg)),
  onOllamaModelsChanged: (cb) => ipcRenderer.on('ollama-models-changed', (_e, msg) => cb(msg)),
};
