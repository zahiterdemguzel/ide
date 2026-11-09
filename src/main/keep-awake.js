const { powerSaveBlocker } = require('electron');
const { createKeepAwake } = require('./keep-awake-lib');

// While an agent works or a command runs, the machine must not idle-sleep (that
// would suspend the work). 'prevent-app-suspension' maps to the macOS
// PreventUserIdleSystemSleep assertion and Windows' ES_SYSTEM_REQUIRED, and still
// lets the display sleep.
const keepAwake = createKeepAwake({
  startBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
  stopBlocker: (id) => powerSaveBlocker.stop(id),
});

module.exports = keepAwake;
