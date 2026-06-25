const { ipcRenderer } = require('electron');

// File explorer (tree/search/read), asset viewer bytes, and the terminal-link
// resolver + external opener.
module.exports = {
  listDir: (rel) => ipcRenderer.invoke('list-dir', rel),
  createFile: (rel) => ipcRenderer.invoke('create-file', rel),
  searchNames: (q) => ipcRenderer.invoke('search-names', q),
  searchRefs: (q) => ipcRenderer.invoke('search-refs', q),
  readText: (file) => ipcRenderer.invoke('read-text', file),
  resolveLinkPath: (raw) => ipcRenderer.invoke('resolve-link-path', raw),
  openExternal: (target) => ipcRenderer.invoke('open-external', target),
  readAsset: (file) => ipcRenderer.invoke('read-asset', file),
  writeAsset: (file, base64) => ipcRenderer.invoke('write-asset', { file, base64 }),
};
