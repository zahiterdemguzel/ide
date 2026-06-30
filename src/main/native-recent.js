const { app, Menu } = require('electron');
const { jumpListCategories, dockMenuItems } = require('./native-recent-menu');

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
    try { app.setJumpList(jumpListCategories(recents, process.execPath, { extraArgs })); }
    catch (err) { console.error('[jump list]', err); }
    return;
  }
  if (process.platform === 'darwin' && app.dock) {
    try {
      const items = dockMenuItems(recents);
      const menu = Menu.buildFromTemplate(
        items.map((it) => ({ label: it.label, click: () => onPick(it.folder) })),
      );
      app.dock.setMenu(menu);
    } catch (err) { console.error('[dock menu]', err); }
  }
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
