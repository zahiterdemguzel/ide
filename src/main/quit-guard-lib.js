// Pure logic for the keyboard quit/close guard: Cmd/Ctrl+W must never close the
// IDE window, and Cmd+Q on macOS only quits when pressed twice in quick
// succession (like Chrome). Kept Electron-free so it's unit-testable;
// quit-guard.js does the Electron wiring.

// How long after the first Cmd+Q a second press still counts as "quit".
const QUIT_CONFIRM_WINDOW_MS = 2000;

// How long after a Cmd/Ctrl+W keypress a window 'close' event is treated as
// caused by that keypress (and blocked). Generous: the keydown and the close
// it triggers arrive back to back, while a deliberate traffic-light click
// right after Cmd+W is unlikely.
const CLOSE_SHORTCUT_GRACE_MS = 1000;

// `input` is Electron's before-input-event Input. The platform's primary
// modifier (Cmd on macOS, Ctrl elsewhere) must be held on its own — Shift/Alt
// combos are other shortcuts.
function isPrimaryCombo(input, platform, key) {
  if (!input || input.type !== 'keyDown') return false;
  if (String(input.key || '').toLowerCase() !== key) return false;
  const primary = platform === 'darwin' ? input.meta : input.control;
  const other = platform === 'darwin' ? input.control : input.meta;
  return !!primary && !other && !input.shift && !input.alt;
}

function isCloseWindowShortcut(input, platform) {
  return isPrimaryCombo(input, platform, 'w');
}

// Only macOS has a Cmd+Q quit convention; Ctrl+Q elsewhere is left alone.
function isQuitShortcut(input, platform) {
  return platform === 'darwin' && isPrimaryCombo(input, platform, 'q');
}

// Tracks Cmd+Q presses: the first returns 'warn' (show "press again"), a second
// within the window returns 'quit'. Auto-repeat while the key is held counts as
// a press too, so holding Cmd+Q also quits — matching Chrome's "hold to quit".
function createQuitConfirmer({ windowMs = QUIT_CONFIRM_WINDOW_MS } = {}) {
  let firstPressAt = null;
  return {
    press(now) {
      if (firstPressAt !== null && now - firstPressAt <= windowMs) {
        firstPressAt = null;
        return 'quit';
      }
      firstPressAt = now;
      return 'warn';
    },
  };
}

// Remembers the last Cmd/Ctrl+W press so a window 'close' that it triggered
// can be told apart from a deliberate close (traffic light, Dock, app.quit).
function createCloseShortcutTracker({ graceMs = CLOSE_SHORTCUT_GRACE_MS } = {}) {
  let lastPressAt = null;
  return {
    recordPress(now) { lastPressAt = now; },
    shouldBlockClose(now) {
      return lastPressAt !== null && now - lastPressAt <= graceMs;
    },
  };
}

module.exports = {
  QUIT_CONFIRM_WINDOW_MS,
  CLOSE_SHORTCUT_GRACE_MS,
  isCloseWindowShortcut,
  isQuitShortcut,
  createQuitConfirmer,
  createCloseShortcutTracker,
};
