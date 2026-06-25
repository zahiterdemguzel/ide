// xterm.js is loaded as a classic <script> before the module graph, so its
// globals are available. Re-export them here so feature modules import from one
// place instead of reaching into `window`.
export const Terminal = window.Terminal;
export const FitAddon = window.FitAddon.FitAddon;

export function termTheme() {
  return {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  };
}

// Wire up clipboard shortcuts for an xterm Terminal instance.
// Must be called after term.open(). Ctrl+C copies when text is selected
// (and lets SIGINT through when nothing is selected). Ctrl+V pastes.
// Right-click copies selection if present, otherwise pastes.
export function attachClipboard(term) {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.key === 'c') {
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel); return false; }
      return true; // no selection → pass SIGINT through to PTY
    }
    if (e.ctrlKey && e.key === 'v') {
      navigator.clipboard.readText().then(text => { if (text) term.paste(text); });
      return false;
    }
    return true;
  });

  // Right-click: copy selection if any, otherwise paste from clipboard.
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel);
    } else {
      navigator.clipboard.readText().then(text => { if (text) term.paste(text); });
    }
  });
}
