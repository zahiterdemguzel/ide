const { app, BrowserWindow, Menu } = require('electron');
// Redirect userData to a per-instance profile dir before any subsystem reads a
// path from it (repo.js derives its config path on load). Must come first.
require('./instance');
const { createWindow } = require('./window');
const { startHookServer } = require('./hook-server');
const { killAllSessions, persistSessions } = require('./sessions');
const { installCrashLogging } = require('./crashlog');

// Requiring each subsystem registers its ipcMain handlers as a load side-effect.
require('./repo');
require('./git');
require('./sessions');
require('./session-commit');
require('./explorer');
require('./run-configs');
require('./runners');
require('./consoles');

// Log every crash (uncaught exception, unhandled rejection, renderer/child-process
// death) to a file under crashlogs/ — without exiting, so the app stays usable.
installCrashLogging();

// Windows: Chromium's GPU shader disk cache repeatedly fails to initialize
// ("Gpu Cache Creation failed", "Unable to move the cache: Access is denied")
// when the userData cache dir is locked. We don't need it — skip it entirely.
app.commandLine.appendSwitch('disable-gpu-disk-cache');

// Windows: Chromium runs its network service in a separate child process that
// repeatedly crashes ("Network service crashed, restarting service") when
// third-party software (antivirus, VPN, firewall shims) injects DLLs into it.
// Merely unsandboxing it (disable-features=NetworkServiceSandbox) is not enough
// — the separate process is still a target for injection and keeps dying.
// Running the network service IN the main process removes the separate child
// entirely, so there is nothing to crash and restart. The app does no
// networking, so there is no security trade-off.
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

// No single-instance lock: each instance runs on its own per-instance profile
// dir (see ./instance), so multiple windows can run side by side without
// fighting over the disk cache.

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no native File/Edit/View menu — the in-app run toolbar replaces it
  startHookServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Snapshot sessions before tearing down the PTYs (killing a live PTY fires its
// onExit, which deletes the entry from the map — so persist must run first).
app.on('window-all-closed', () => {
  persistSessions();
  killAllSessions();
  if (process.platform !== 'darwin') app.quit();
});

// macOS keeps the app alive after the window closes; persist on the real quit too
// so an active session that was never archived still survives the next launch.
app.on('before-quit', () => persistSessions());
