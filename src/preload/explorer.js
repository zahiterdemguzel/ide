const { ipcRenderer, webUtils } = require('electron');

// File explorer (tree/search/read), asset viewer bytes, and the terminal-link
// resolver + external opener.
module.exports = {
  // Resolve the absolute filesystem path of a File from an OS drag-drop.
  // Electron 31 removed File.path; webUtils.getPathForFile is the replacement.
  pathForFile: (file) => webUtils.getPathForFile(file),
  // Spill a clipboard image to a temp PNG; returns { ok, path } or { ok: false }.
  pasteImage: () => ipcRenderer.invoke('paste-image'),
  // Terminal copy/paste via the main-process clipboard (reliable under file://).
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard-read'),
  listDir: (rel) => ipcRenderer.invoke('list-dir', rel),
  createFile: (rel) => ipcRenderer.invoke('create-file', rel),
  createFolder: (rel) => ipcRenderer.invoke('create-folder', rel),
  searchNames: (q) => ipcRenderer.invoke('search-names', q),
  listFiles: () => ipcRenderer.invoke('list-files'),
  searchRefs: (q) => ipcRenderer.invoke('search-refs', q),
  readText: (file) => ipcRenderer.invoke('read-text', file),
  readTextAbs: (abs) => ipcRenderer.invoke('read-text-abs', abs),
  writeText: (file, text) => ipcRenderer.invoke('write-text', { file, text }),
  writeTextAbs: (abs, text) => ipcRenderer.invoke('write-text-abs', { abs, text }),
  // Resolve a repo-relative path to a file:// URL (the editor's HTML preview).
  fileUrl: (file) => ipcRenderer.invoke('file-url', file),
  resolveLinkPath: (raw, baseDir) => ipcRenderer.invoke('resolve-link-path', raw, baseDir),
  openExternal: (target) => ipcRenderer.invoke('open-external', target),
  // Clear the inline browser's persistent cookies (the persist:browser partition).
  clearWebData: () => ipcRenderer.invoke('clear-web-data'),
  renameFile: (oldRel, newRel) => ipcRenderer.invoke('rename-file', oldRel, newRel),
  deleteFile: (rel) => ipcRenderer.invoke('delete-file', rel),
  revealInFolder: (rel) => ipcRenderer.invoke('reveal-in-folder', rel),
  // Open a repo-relative asset in the OS default program for its file type.
  openAssetExternal: (rel) => ipcRenderer.invoke('open-asset-external', rel),
  readAsset: (file) => ipcRenderer.invoke('read-asset', file),
  writeAsset: (file, base64) => ipcRenderer.invoke('write-asset', { file, base64 }),
  // Fired (debounced in main) whenever the open repo changes on disk, so the tree
  // can auto-refresh without a manual refresh button. `paths` lists the
  // repo-relative files that changed (null when the watcher couldn't tell).
  onTreeChanged: (cb) => ipcRenderer.on('tree-changed', (_e, paths) => cb(paths)),
};
