const { contextBridge } = require('electron');

// The entire IPC surface, composed from one channel-group module per domain.
// Add a new channel to the matching group (or a new group) — never inline here.
contextBridge.exposeInMainWorld('api', {
  ...require('./settings-store'), // first: restores localStorage before the page reads it
  ...require('./sessions'),
  ...require('./git'),
  ...require('./explorer'),
  ...require('./db'),
  ...require('./diagram'),
  ...require('./run-configs'),
  ...require('./debug'),
  ...require('./lsp'),
  ...require('./runners'),
  ...require('./consoles'),
  ...require('./onboarding'),
  ...require('./remote'),
  ...require('./ollama'),
  ...require('./stt'),
  ...require('./ai'),
  ...require('./accounts'),
});
