// Pure logic for the OS-native "recent projects" menus: the Windows taskbar
// Jump List (right-click the taskbar icon) and the macOS Dock menu (right-click
// the dock icon). Kept Electron-free so it's unit-testable; native-recent.js does
// the Electron wiring and ready-gating.

// The project name shown for a path — its last path segment, matching the
// in-app recent menu's label. Handles both `\` and `/` separators.
function folderLabel(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

// Windows Jump List: a custom "Recent" category of task items that relaunch the
// app pointed at a folder. Each runs `<exe> [extraArgs…] --folder="<path>"`, the
// same CLI override the app already understands, so picking one opens that project
// in a new window. `extraArgs` carries leading args the relaunch needs — for a
// dev run (`electron .`) the exe is the bare Electron binary, so the app's path
// must be passed first or it has nothing to run; packaged, it's empty. Returns []
// when there's nothing recent so the category is omitted.
function jumpListCategories(recents, execPath, { extraArgs = [], categoryName = 'Recent' } = {}) {
  const prefix = extraArgs.length ? `${extraArgs.join(' ')} ` : '';
  const items = (Array.isArray(recents) ? recents : [])
    .filter((p) => typeof p === 'string' && p)
    .map((dir) => ({
      type: 'task',
      program: execPath,
      args: `${prefix}--folder="${dir}"`,
      title: folderLabel(dir),
      description: dir,
    }));
  return items.length ? [{ type: 'custom', name: categoryName, items }] : [];
}

// macOS Dock menu: plain {label, folder} descriptors the wiring turns into
// MenuItems with click handlers (which switch the running app's folder in place).
function dockMenuItems(recents) {
  return (Array.isArray(recents) ? recents : [])
    .filter((p) => typeof p === 'string' && p)
    .map((dir) => ({ label: folderLabel(dir), folder: dir }));
}

// Windows Jump List: a "Tasks" entry that launches a fresh instance (no
// `--folder`, so it reopens the last folder). Same exe/extraArgs rules as above.
function newWindowTask(execPath, { extraArgs = [], title = 'New Window' } = {}) {
  return { type: 'task', program: execPath, args: extraArgs.join(' '), title, description: title };
}

// How to start one more instance of the app. On macOS, clicking the Dock icon of a
// running app only re-activates it, so a second instance has to be launched
// explicitly: packaged, `open -n <bundle>` asks LaunchServices for a new instance
// of the .app (execPath is `<bundle>/Contents/MacOS/<name>`); everywhere else, and
// in a dev run where the exe is the bare Electron binary, spawn the exe directly
// with the app directory as its first arg.
function newInstanceCommand({ platform, isPackaged, execPath, appPath }) {
  if (platform === 'darwin' && isPackaged) {
    const bundleMatch = execPath.match(/^(.*?\.app)\/Contents\/MacOS\//);
    if (bundleMatch) return { command: 'open', args: ['-n', bundleMatch[1]] };
  }
  return { command: execPath, args: isPackaged ? [] : [appPath] };
}

module.exports = { folderLabel, jumpListCategories, dockMenuItems, newWindowTask, newInstanceCommand };
