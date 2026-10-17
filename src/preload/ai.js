const { ipcRenderer } = require('electron');

// Editor AI assist (src/main/ai-assist.js): ghost-text completions and inline edits.
module.exports = {
  aiComplete: (req) => ipcRenderer.invoke('ai-complete', req),
  aiEdit: (req) => ipcRenderer.invoke('ai-edit', req),
  aiCancel: (id) => ipcRenderer.invoke('ai-cancel', { id }),
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  // Raw text deltas of a streaming ai-edit, as { id, text }. Returns an unsubscribe.
  onAiEditChunk: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on('ai-edit-chunk', fn);
    return () => ipcRenderer.removeListener('ai-edit-chunk', fn);
  },
};
