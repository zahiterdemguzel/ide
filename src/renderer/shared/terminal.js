// xterm.js is loaded as a classic <script> before the module graph, so its
// globals are available. Re-export them here so feature modules import from one
// place instead of reaching into `window`.
export const Terminal = window.Terminal;
export const FitAddon = window.FitAddon.FitAddon;

// xterm renders to a canvas, so it can't read CSS variables itself. We bridge
// the active theme into an xterm theme object by reading the --term-* custom
// properties off <html> (defined per theme in styles/themes.css). New terminals
// pick these up at construction; live ones are refreshed via refreshTermThemes.
export function termTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--term-bg', '#1e1e1e'),
    foreground: v('--term-fg', '#d4d4d4'),
    cursor: v('--term-cursor', '#d4d4d4'),
    selectionBackground: v('--term-sel', '#264f78'),
  };
}

// Live terminals that should track theme changes. Modules register on create
// and unregister on dispose; settings.js calls refreshTermThemes() after the
// user switches theme so every open console/session recolors immediately.
const themedTerminals = new Set();
export function trackTermTheme(term) { themedTerminals.add(term); }
export function untrackTermTheme(term) { themedTerminals.delete(term); }
export function refreshTermThemes() {
  const theme = termTheme();
  for (const term of themedTerminals) term.options.theme = theme;
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
