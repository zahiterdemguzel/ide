const { ipcRenderer } = require('electron');

// Desktop voice input and session gestures (see server/protocol.js for phone clips).
module.exports = {
  onSessionForceClick: (cb) => ipcRenderer.on('session-force-click', (_e, point) => cb(point)),
  sttStatus: () => ipcRenderer.invoke('stt-status'),
  sttWarm: (opts) => ipcRenderer.invoke('stt-warm', opts),
  sttStart: (opts) => ipcRenderer.invoke('stt-start', opts),
  sttAudio: (samples) => ipcRenderer.send('stt-audio', samples),
  sttStop: () => ipcRenderer.send('stt-stop'),
  sttFinish: () => ipcRenderer.invoke('stt-finish'),
  sttRelease: () => ipcRenderer.send('stt-release'),
  onRowPreview: (cb) => ipcRenderer.on('stt-row-preview', (_e, msg) => cb(msg)),
  onRowSilence: (cb) => ipcRenderer.on('stt-row-silence', (_e, id) => cb(id)),
  onSttText: (cb) => ipcRenderer.on('stt-text', (_e, msg) => cb(msg)),
  onSttBusy: (cb) => ipcRenderer.on('stt-busy', (_e, msg) => cb(msg)),
  onSttError: (cb) => ipcRenderer.on('stt-error', (_e, msg) => cb(msg)),
};
