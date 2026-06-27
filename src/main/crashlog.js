const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { crashLogName, formatCrash } = require('./crashlog-lib');

// Crash logs land in a `crashlogs/` folder in a *persistent* location, written
// synchronously so the log survives even a fatal uncaughtException that ends the
// process right after.
//
// A portable build (electron-builder `target: portable`) self-extracts to a
// throwaway %TEMP% dir on every launch and deletes it on exit, so writing next to
// `app.getPath('exe')` (which points *inside* that temp dir) loses every crash log
// the moment the app closes — exactly when we need it. electron-builder exposes the
// real, on-disk folder the user launched the .exe from via `PORTABLE_EXECUTABLE_DIR`;
// prefer it so logs persist across runs. Fall back to next-to-exe for an installed
// build, and the project root in dev.
function crashDir() {
  const base = process.env.PORTABLE_EXECUTABLE_DIR
    || (app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath());
  return path.join(base, 'crashlogs');
}

function writeCrashLog(kind, err) {
  try {
    const dir = crashDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, crashLogName()), formatCrash(kind, err));
  } catch (e) {
    // Logging the crash failed (read-only dir, disk full) — don't let that throw
    // become a second crash; the console is the last resort.
    console.error('[crashlog] failed to write', e);
  }
}

// Record every uncaught exception / unhandled rejection in the main process and
// every renderer/child-process crash to a crash log. This does NOT exit — the app
// is kept alive (window.js already reloads a dead renderer); the log is a forensic
// trail for "the actual crashes we got".
function installCrashLogging() {
  process.on('uncaughtException', (err) => { console.error('[main uncaught]', err); writeCrashLog('uncaughtException', err); });
  process.on('unhandledRejection', (err) => { console.error('[main unhandledRejection]', err); writeCrashLog('unhandledRejection', err); });
  app.on('render-process-gone', (_e, _wc, details) => {
    if (details.reason === 'clean-exit') return;
    writeCrashLog('render-process-gone', new Error(`renderer gone: ${details.reason} (exitCode ${details.exitCode})`));
  });
  app.on('child-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    writeCrashLog('child-process-gone', new Error(`${details.type} gone: ${details.reason} (exitCode ${details.exitCode})`));
  });
}

module.exports = { installCrashLogging, writeCrashLog, crashDir };
