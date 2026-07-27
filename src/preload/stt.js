const { ipcRenderer } = require('electron');

// Voice input (speech-to-text). Desktop-only: the feature is driven by this
// machine's mouse cursor and microphone, so unlike the model channels none of
// these are exposed to a paired phone (see server/protocol.js).
module.exports = {
  sttStatus: () => ipcRenderer.invoke('stt-status'),
  sttWarm: (opts) => ipcRenderer.invoke('stt-warm', opts),
  sttStart: (opts) => ipcRenderer.invoke('stt-start', opts),
  sttAudio: (samples) => ipcRenderer.send('stt-audio', samples),
  sttStop: () => ipcRenderer.send('stt-stop'),
  sttRelease: () => ipcRenderer.send('stt-release'),
  onSttText: (cb) => ipcRenderer.on('stt-text', (_e, msg) => cb(msg)),
  onSttBusy: (cb) => ipcRenderer.on('stt-busy', (_e, msg) => cb(msg)),
  onSttError: (cb) => ipcRenderer.on('stt-error', (_e, msg) => cb(msg)),
};
