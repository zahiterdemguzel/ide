const { ipcRenderer } = require('electron');

// The DAP debugger (main/debug.js): start/stop sessions, stepping and
// inspection requests, breakpoints, and the session event stream.
module.exports = {
  debugStart: (args) => ipcRenderer.invoke('debug-start', args),
  debugStartFile: (args) => ipcRenderer.invoke('debug-start-file', args),
  debugStop: (sessionId) => ipcRenderer.invoke('debug-stop', { sessionId }),
  debugRequest: (sessionId, command, args) => ipcRenderer.invoke('debug-request', { sessionId, command, args }),
  debugSetBreakpoints: (payload) => ipcRenderer.invoke('debug-set-breakpoints', payload),
  debugSetExceptionFilters: (sessionId, filters) => ipcRenderer.invoke('debug-set-exception-filters', { sessionId, filters }),
  onDebugEvent: (cb) => ipcRenderer.on('debug-event', (_e, msg) => cb(msg)),
};
