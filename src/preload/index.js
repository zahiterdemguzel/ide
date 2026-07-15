const { contextBridge } = require('electron');

// The entire IPC surface, composed from one channel-group module per domain.
// Add a new channel to the matching group (or a new group) — never inline here.
contextBridge.exposeInMainWorld('api', {
  ...require('./sessions'),
  ...require('./git'),
  ...require('./explorer'),
  ...require('./db'),
  ...require('./run-configs'),
  ...require('./runners'),
  ...require('./consoles'),
  ...require('./onboarding'),
  ...require('./remote'),
  ...require('./ollama'),
});
