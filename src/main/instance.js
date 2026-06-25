const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// Multiple instances must be able to run side by side. Two instances sharing one
// userData dir fight over the Chromium disk cache / singleton lock ("Unable to
// move the cache: Access is denied"), which is why a single-instance lock used to
// be required. Instead, give every instance its own throwaway profile dir so they
// never collide.
//
// `sharedDataDir` is the default userData location, captured *before* the
// redirect. Persistent app config (e.g. last-folder) lives here so it survives
// restarts and is common to all instances; the per-instance profile holds only
// the disposable Chromium cache.
const sharedDataDir = app.getPath('userData');

const instanceDir = path.join(sharedDataDir, 'instances', String(process.pid));
app.setPath('userData', instanceDir);

// The per-instance profile is disposable — drop it when this instance exits so
// the dirs don't pile up across runs.
app.on('quit', () => {
  try { fs.rmSync(instanceDir, { recursive: true, force: true }); } catch {}
});

module.exports = { sharedDataDir };
