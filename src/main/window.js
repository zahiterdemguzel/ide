const { BrowserWindow } = require('electron');
const path = require('path');

let win = null;
const getWin = () => win;

// Send to the renderer only when it can actually receive. After the renderer
// process dies (e.g. Chromium "Network service crashed" → render-process-gone),
// the BrowserWindow object survives but its render frame is disposed, so a bare
// `win.webContents.send` throws "Render frame was disposed before WebFrameMain
// could be accessed". That throw escapes async callbacks (notably node-pty's
// onData) as an unhandled main-process exception. Guard the known-bad states and
// swallow the residual race where the frame dies between the check and the send.
function sendToRenderer(channel, payload) {
  if (!win || win.isDestroyed()) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

// The OS window title doubles as the "which folder is open" indicator (there is
// no in-app folder label). Show the project name — the repo path's basename.
function setWindowTitle(folderPath) {
  if (win && folderPath) win.setTitle(`IDE / ${path.basename(folderPath)}`);
}

let lastReloadAt = 0;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
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
    process.stderr.write(`[renderer:${levels[level] || level}] ${message} (${source}:${line})\n`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode);
    // The window outlives the dead renderer; without a reload the UI is frozen
    // for good. Reload to recover, but throttle so a renderer that crashes on
    // load can't spin in a reload→crash loop.
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    const now = Date.now();
    if (now - lastReloadAt < 3000) return;
    lastReloadAt = now;
    win.reload();
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });
  return win;
}

module.exports = { createWindow, getWin, setWindowTitle, sendToRenderer };
