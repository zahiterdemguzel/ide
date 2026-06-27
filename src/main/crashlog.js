const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { crashLogName, formatCrash } = require('./crashlog-lib');

// Crash logs land in a `crashlogs/` folder next to the executable when packaged,
// else in the project root in dev. Each crash is its own timestamped file, written
// synchronously so the log survives even a fatal uncaughtException that ends the
// process right after.
function crashDir() {
  const base = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath();
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
