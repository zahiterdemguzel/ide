const { ipcRenderer } = require('electron');

// Diagram panel. `build` re-indexes the open project with tree-sitter (the only
// call that touches disk — `force` skips the worker's per-file mtime cache);
// `layout` projects that index to one diagram type with the pass switches the
// user has on, so toggling a switch never re-reads a file.
module.exports = {
  diagramBuild: (opts) => ipcRenderer.invoke('diagram-build', opts || {}),
  diagramLayout: (opts) => ipcRenderer.invoke('diagram-layout', opts || {}),
};
