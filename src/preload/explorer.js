const { ipcRenderer, webUtils } = require('electron');

// File explorer (tree/search/read), asset viewer bytes, and the terminal-link
// resolver + external opener.
module.exports = {
  // Resolve the absolute filesystem path of a File from an OS drag-drop.
  // Electron 31 removed File.path; webUtils.getPathForFile is the replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
  // Spill a clipboard image to a temp PNG; returns { ok, path } or { ok: false }.
  pasteImage: () => ipcRenderer.invoke('paste-image'),
  listDir: (rel) => ipcRenderer.invoke('list-dir', rel),
  createFile: (rel) => ipcRenderer.invoke('create-file', rel),
  createFolder: (rel) => ipcRenderer.invoke('create-folder', rel),
  searchNames: (q) => ipcRenderer.invoke('search-names', q),
  searchRefs: (q) => ipcRenderer.invoke('search-refs', q),
  readText: (file) => ipcRenderer.invoke('read-text', file),
  writeText: (file, text) => ipcRenderer.invoke('write-text', { file, text }),
  resolveLinkPath: (raw) => ipcRenderer.invoke('resolve-link-path', raw),
  openExternal: (target) => ipcRenderer.invoke('open-external', target),
  renameFile: (oldRel, newRel) => ipcRenderer.invoke('rename-file', oldRel, newRel),
  deleteFile: (rel) => ipcRenderer.invoke('delete-file', rel),
  readAsset: (file) => ipcRenderer.invoke('read-asset', file),
  writeAsset: (file, base64) => ipcRenderer.invoke('write-asset', { file, base64 }),
};
