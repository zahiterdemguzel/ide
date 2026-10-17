const { ipcRenderer } = require('electron');

// Language servers (main/lsp.js): start/stop a server and the raw JSON-RPC pipe
// the renderer's editor/lsp-client.js speaks over. `lspSend` is fire-and-forget
// (ipcRenderer.send) so messages reach the server in the order they were sent.
module.exports = {
  lspEnsure: (languageId, root) => ipcRenderer.invoke('lsp-ensure', { languageId, root }),
  lspSend: (key, message) => ipcRenderer.send('lsp-send', { key, message }),
  lspStop: (key) => ipcRenderer.invoke('lsp-stop', { key }),
  lspStopAll: () => ipcRenderer.invoke('lsp-stop-all'),
  onLspMessage: (cb) => ipcRenderer.on('lsp-message', (_e, msg) => cb(msg)),
  onLspExit: (cb) => ipcRenderer.on('lsp-exit', (_e, msg) => cb(msg)),
};
