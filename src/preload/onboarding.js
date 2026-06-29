const { ipcRenderer } = require('electron');

// First-run onboarding flags, persisted in the shared data dir by the main
// process (renderer localStorage doesn't survive the per-instance profile wipe).
module.exports = {
  onboardingGet: () => ipcRenderer.invoke('onboarding-get'),
  onboardingSetTourDone: () => ipcRenderer.invoke('onboarding-set-tour-done'),
  onboardingReset: () => ipcRenderer.invoke('onboarding-reset'),
};
