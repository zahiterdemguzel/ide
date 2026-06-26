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

// Copy text to the clipboard, falling back to execCommand if the async
// Clipboard API rejects (it requires document focus, which Electron can
// transiently lack right after a selection in the terminal canvas).
function copyToClipboard(text) {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

// Default formatter for a pasted image's temp-file path: quote it if it has
// spaces, so it survives as a single argument in a shell. Sessions override this
// to emit an "@<path>" mention (see attachClipboard's opts.formatImagePath).
const quoteIfSpaced = (p) => (/\s/.test(p) ? `"${p}"` : p);

// Wire up clipboard shortcuts for an xterm Terminal instance.
// Must be called after term.open(). Ctrl+C copies when text is selected
// (and lets SIGINT through when nothing is selected). Ctrl+V / right-click
// paste; right-click copies first if there is a selection.
//
// Paste checks the clipboard for an image before falling back to text: a bitmap
// is spilled to a temp PNG (main's `paste-image`) and its path is pasted,
// formatted by opts.formatImagePath (default: quote-if-spaced).
//
// Note: while an app (e.g. the Claude CLI) has mouse reporting on, a plain
// drag is sent to the app instead of selecting text. Hold Shift while
// dragging to force a local selection — xterm honors Shift as the override.
export function attachClipboard(term, opts = {}) {
  const formatImagePath = opts.formatImagePath || quoteIfSpaced;

  async function paste() {
    const img = await window.api.pasteImage();
    if (img && img.ok && img.path) { term.paste(formatImagePath(img.path)); return; }
    const text = await navigator.clipboard.readText();
    if (text) term.paste(text);
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    // Normalize case: with Shift held, e.key is uppercase ('C'/'V').
    const key = e.key.toLowerCase();
    if (key === 'c') {
      const sel = term.getSelection();
      if (sel) { copyToClipboard(sel); return false; }
      return true; // no selection → pass SIGINT through to PTY
    }
    // preventDefault stops the browser's native paste event from also firing
    // into xterm's textarea, which would paste a second time.
    if (key === 'v') { e.preventDefault(); paste(); return false; }
    return true;
  });

  // Right-click: copy selection if any, otherwise paste from clipboard.
  term.element.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = term.getSelection();
    if (sel) copyToClipboard(sel);
    else paste();
  });
}
