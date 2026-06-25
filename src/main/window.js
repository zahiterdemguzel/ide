const { BrowserWindow } = require('electron');
const path = require('path');

let win = null;
const getWin = () => win;

// The OS window title doubles as the "which folder is open" indicator (there is
// no in-app folder label). Show the project name — the repo path's basename.
function setWindowTitle(folderPath) {
  if (win && folderPath) win.setTitle(`IDE / ${path.basename(folderPath)}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload requires native node-pty
      webviewTag: true, // inline web browser for Ctrl+clicked links
    },
  });
  win.loadFile('index.html');
  win.setTitle('IDE');
  // Keep the title under our control: ignore the <title> the page would push.
  win.on('page-title-updated', (e) => e.preventDefault());

  // Surface renderer-side problems in the `npm start` terminal — by default
  // console output and uncaught errors only show in DevTools, so a silently
  // broken button (e.g. a thrown click handler) leaves no trace otherwise.
  const levels = ['log', 'info', 'warning', 'error']; // chromium console levels
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${levels[level] || level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });
  return win;
}

module.exports = { createWindow, getWin, setWindowTitle };
