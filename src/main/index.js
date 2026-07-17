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
const { createWindow } = require('./window');
const { startHookServer } = require('./hook-server');
const { killAllSessions, persistSessions } = require('./sessions');
const { installCrashLogging } = require('./crashlog');

// Requiring each subsystem registers its ipcMain handlers as a load side-effect.
require('./repo');
require('./git');
require('./sessions');
require('./chat'); // the chat view of a session (transcript, prompts, attachments)
require('./session-commit');
require('./explorer');
require('./db');
require('./run-configs');
require('./runners');
require('./consoles');
require('./onboarding-store');
require('./remote');
require('./ollama'); // embedded Ollama engine + custom-models IPC (lazy — nothing starts here)

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
// entirely, so there is nothing to crash and restart. This only affects
// Chromium (renderer) networking; the Node ws server in main (remote access)
// and outbound https calls are unaffected, so there is no security trade-off.
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess');
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox');

// The remote browser (src/main/remote-browser.js) renders an offscreen
// BrowserWindow and reads each frame off the CPU via image.toJPEG() in the
// `paint` event — Electron's "software output device" OSR mode. That mode
// requires hardware acceleration to be OFF: with it on, creating the offscreen
// window crashes the GPU process on Windows (crashpad "not connected", taking
// the whole app down). This is the documented requirement for CPU-side OSR
// frames, so it MUST come before app is ready and it supersedes the GPU
// rasterization tuning below (those switches are inert without HW accel).
app.disableHardwareAcceleration();
// Distinctive startup marker so a running app can be confirmed to include this
// fix (the "GPU stall / GL Driver Message" renderer logs persist under software
// WebGL and are NOT a reliable signal). If this line is absent from the log, the
// process is stale/prebuilt and the offscreen browser will still crash.
console.log('[gpu] hardware acceleration disabled for offscreen remote-browser OSR');

// Would offload web-content rasterization to the GPU and skip the CPU copy of
// tiles (zero-copy) for smoother panel scrolling / terminal compositing — but
// these are no-ops now that hardware acceleration is disabled for the remote
// browser's software OSR (above). Kept as intent markers: if OSR ever moves to
// the GPU shared-texture path (webPreferences.offscreen.useSharedTexture), drop
// disableHardwareAcceleration and these become live again. Deliberately moderate
// either way: we do NOT pass ignore-gpu-blocklist.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

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
  stopOllamaRuntime();
  if (process.platform !== 'darwin') app.quit();
});

// macOS keeps the app alive after the window closes; persist on the real quit too
// so an active session that was never archived still survives the next launch.
// Also tear the engine/proxy down here so nothing leaks on the darwin quit path.
app.on('before-quit', () => { persistSessions(); stopOllamaRuntime(); });

// Kill the embedded Ollama engine (and its model-runner children) and close the
// translation proxy. Lazy-required so a launch that never touches Ollama pays
// nothing; both are no-ops when never started.
function stopOllamaRuntime() {
  try { require('./ollama').stopOllama(); } catch { /* never started */ }
  try { require('./ollama-proxy').stopProxyServer(); } catch { /* never started */ }
}
