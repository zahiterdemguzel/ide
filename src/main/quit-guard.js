const { app } = require('electron');
const { sendToRenderer } = require('./window');
const {
  QUIT_CONFIRM_WINDOW_MS,
  isCloseWindowShortcut,
  isQuitShortcut,
  createQuitConfirmer,
  createCloseShortcutTracker,
} = require('./quit-guard-lib');

// Keyboard guard against losing the whole IDE to a stray shortcut:
//  - Cmd/Ctrl+W never closes the window (the editor still uses it to close a tab).
//  - Cmd+Q on macOS needs a second press within QUIT_CONFIRM_WINDOW_MS; the first
//    shows a "press again to quit" pill (renderer/quit-warning.js).
// Quitting from the Dock or a traffic-light close is left untouched.
const quitConfirmer = createQuitConfirmer();
const closeShortcutTracker = createCloseShortcutTracker();
let quitting = false;

function handleInput(event, input) {
  const now = Date.now();
  if (isCloseWindowShortcut(input, process.platform)) {
    // Not preventDefault: the page still sees the keydown so an open editor tab
    // closes. Only the window 'close' it may trigger is blocked below.
    closeShortcutTracker.recordPress(now);
    return;
  }
  if (isQuitShortcut(input, process.platform)) {
    event.preventDefault();
    if (quitConfirmer.press(now) === 'quit') app.quit();
    else sendToRenderer('quit-warning', { windowMs: QUIT_CONFIRM_WINDOW_MS });
  }
}

function installQuitGuard() {
  // Every webContents, not just the main window's: a focused <webview> (inline
  // browser) receives the keystrokes itself. The offscreen remote browser only
  // gets synthesized phone input, so it's skipped.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.isOffscreen()) return;
    contents.on('before-input-event', handleInput);
  });
  app.on('browser-window-created', (_e, window) => {
    window.on('close', (event) => {
      if (!quitting && closeShortcutTracker.shouldBlockClose(Date.now())) event.preventDefault();
    });
  });
  app.on('before-quit', () => { quitting = true; });
}

module.exports = { installQuitGuard };
