const T0 = Date.now(); // PERF-TEMP
const perf = (label) => console.error(`[perf-main] +${Date.now() - T0}ms ${label}`); // PERF-TEMP
perf('main module start'); // PERF-TEMP
const { app, BrowserWindow, Menu } = require('electron');
// Windows ties a toast notification's click activation to the AppUserModelID of
// the process that posted it. Without this, Windows has no reliable way to route
// a notification click back to this (especially unpackaged/dev) process, so
// Notification's 'click' handler (src/main/window.js) silently never fires. Must
// be set before any Notification is constructed — doing it up front is simplest.
// Matches the installed app's identity (package.json build.appId).
if (process.platform === 'win32') app.setAppUserModelId('com.claude.session-editor');
// Redirect userData to a per-instance profile dir before any subsystem reads a
// path from it (repo.js derives its config path on load). Must come first.
require('./instance');
perf('instance loaded'); // PERF-TEMP
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
require('./db');
require('./run-configs');
require('./runners');
require('./consoles');
require('./onboarding-store');
perf('subsystems loaded'); // PERF-TEMP

// Log every crash (uncaught exception, unhandled rejection, renderer/child-process
// death) to a file under crashlogs/ — without exiting, so the app stays usable.
installCrashLogging();

// Windows: Chromium's GPU shader disk cache repeatedly fails to initialize
// ("Gpu Cache Creation failed", "Unable to move the cache: Access is denied")
// when the per-instance userData cache dir is locked (antivirus scanning the
// freshly created dir, or another instance). We don't need it — skip it entirely.
// The switch MUST be exactly `disable-gpu-shader-disk-cache`: Chromium silently
// ignores unknown switches, and the old `disable-gpu-disk-cache` is not a real
// switch — it was a no-op, so the cache stayed on and the errors persisted.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

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

// Offload web-content rasterization to the GPU and skip the CPU copy of tiles
// into the GPU (zero-copy), so panel scrolling and the terminal canvas composite
// smoothly. Deliberately moderate: we do NOT pass ignore-gpu-blocklist, so a
// machine whose GPU/driver Chromium has blocklisted still falls back to software
// rather than risking the instability that forcing past the blocklist can cause.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

// No single-instance lock: each instance runs on its own per-instance profile
// dir (see ./instance), so multiple windows can run side by side without
// fighting over the disk cache.

app.whenReady().then(() => {
  perf('app ready'); // PERF-TEMP
  Menu.setApplicationMenu(null); // no native File/Edit/View menu — the in-app run toolbar replaces it
  startHookServer();
  perf('hook server started'); // PERF-TEMP
  const w = createWindow();
  perf('window created'); // PERF-TEMP
  w.webContents.once('did-finish-load', () => perf('did-finish-load')); // PERF-TEMP
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
