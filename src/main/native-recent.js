const { app, Menu } = require('electron');
const { spawn } = require('child_process');
const { jumpListCategories, dockMenuItems, newWindowTask, newInstanceCommand } = require('./native-recent-menu');

// Push the recent-projects list into the OS-native menus: the Windows taskbar
// Jump List and the macOS Dock menu. Both are no-ops on other platforms. The
// Jump List relaunches the exe with `--folder=<path>` (a fresh window — this app
// is multi-instance), so it needs no callback; the Dock menu switches the running
// app's folder in place, so `onPick(folder)` is invoked for it.
function applyNativeRecent(recents, onPick) {
  if (process.platform === 'win32') {
    // In a dev run the exe is the bare Electron binary, so the relaunch must pass
    // the app directory before `--folder`; a packaged exe is the app itself.
    const extraArgs = app.isPackaged ? [] : [`"${app.getAppPath()}"`];
    const tasks = { type: 'tasks', items: [newWindowTask(process.execPath, { extraArgs })] };
    try { app.setJumpList([tasks, ...jumpListCategories(recents, process.execPath, { extraArgs })]); }
    catch (err) { console.error('[jump list]', err); }
    return;
  }
  if (process.platform === 'darwin' && app.dock) {
    try {
      const recentItems = dockMenuItems(recents)
        .map((it) => ({ label: it.label, click: () => onPick(it.folder) }));
      const menu = Menu.buildFromTemplate([
        { label: 'New Window', click: launchNewInstance },
        ...(recentItems.length ? [{ type: 'separator' }, ...recentItems] : []),
      ]);
      app.dock.setMenu(menu);
    } catch (err) { console.error('[dock menu]', err); }
  }
}

// Start a separate, detached instance (each runs on its own profile dir, see
// instance.js), so it outlives this one and owns its own windows.
function launchNewInstance() {
  const { command, args } = newInstanceCommand({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
  });
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error('[new instance]', err));
    child.unref();
  } catch (err) { console.error('[new instance]', err); }
}

// repo.js refreshes the native menus at module-load time (before app `ready`) and
// again on every folder change. Both native APIs require a ready app, so defer
// the first build and coalesce any pre-ready calls to the latest one.
let ready = false;
let pending = null;
app.whenReady().then(() => {
  ready = true;
  if (pending) { applyNativeRecent(pending.recents, pending.onPick); pending = null; }
});

function refreshNativeRecent(recents, onPick) {
  if (!ready) { pending = { recents, onPick }; return; }
  applyNativeRecent(recents, onPick);
}

module.exports = { refreshNativeRecent };
