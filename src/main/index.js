const { app, BrowserWindow, Menu } = require('electron');
const { createWindow } = require('./window');
const { startHookServer } = require('./hook-server');
const { killAllSessions } = require('./sessions');

// Requiring each subsystem registers its ipcMain handlers as a load side-effect.
require('./repo');
require('./git');
require('./sessions');
require('./session-commit');
require('./explorer');
require('./run-configs');
require('./consoles');

process.on('uncaughtException', (err) => console.error('[main uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[main unhandledRejection]', err));

// Windows: Chromium's GPU shader disk cache repeatedly fails to initialize
// ("Gpu Cache Creation failed", "Unable to move the cache: Access is denied")
// when the userData cache dir is locked. We don't need it — skip it entirely.
app.commandLine.appendSwitch('disable-gpu-disk-cache');

// Windows: the sandboxed network-service process repeatedly crashes
// ("Network service crashed, restarting service") when third-party software
// (antivirus, VPN, firewall shims) injects DLLs into it. Disabling the network
// service sandbox stops the crash loop. The app does no networking, so there is
// no security trade-off.
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

// A second instance pointed at the same userData dir fights over the disk cache
// (the "Unable to move the cache: Access is denied" warning). Keep one instance;
// relaunches just focus the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no native File/Edit/View menu — the in-app run toolbar replaces it
  startHookServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  killAllSessions();
  if (process.platform !== 'darwin') app.quit();
});
