import { findTerminalLinks } from './shared/terminal-links-parse.js';
import { openFromTree, showWeb } from './viewer/center.js';

// --- terminal Ctrl+click links (file paths + web URLs) ---
// VS Code feel: links only light up while Ctrl (Cmd on mac) is held, so normal
// hover and drag-to-select are untouched. Activating a link routes to the file
// viewer or the inline browser.
//
// We can't gate provideLinks on the key state: xterm only re-queries it when the
// mouse moves to a new cell, so gating there would force the user to press Ctrl
// *before* hovering and to keep the terminal focused. Instead we always provide
// links (decorated per the current modifier) and, while one is hovered, flip its
// decorations live the instant Ctrl is pressed or released — xterm exposes live
// `decorations.underline`/`pointerCursor` setters on the hovered link.
let linkModDown = false;
let hoveredLink = null; // the ILink xterm is currently hovering, or null
const onMac = navigator.platform.toLowerCase().includes('mac');

// Reflect the current modifier state onto the hovered link's decorations.
function applyLinkMod() {
  if (!hoveredLink) return;
  hoveredLink.decorations.underline = linkModDown;
  hoveredLink.decorations.pointerCursor = linkModDown;
}

function setLinkMod(down) {
  if (linkModDown === down) return;
  linkModDown = down;
  applyLinkMod();
}

// Capture phase so the modifier is tracked no matter which element has focus
// (a focused panel that stops propagation would otherwise hide the key from us).
window.addEventListener('keydown', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) setLinkMod(true); }, true);
window.addEventListener('keyup', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) setLinkMod(false); }, true);
window.addEventListener('blur', () => setLinkMod(false));

async function openTerminalLink(kind, raw, baseDir) {
  if (kind === 'url') { showWeb(raw); return; }
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw); // split a trailing :line[:col]
  const p = m ? m[1] : raw;
  const line = m ? Number(m[2]) : null;
  const r = await window.api.resolveLinkPath(p, baseDir);
  if (!r || !r.ok) return;
  if (r.isDir) { window.api.openExternal(r.abs); return; } // OS file browser
  if (!r.isFile) return;
  if (r.inRepo) openFromTree(r.rel, line ? { line, term: null } : null);
  else window.api.openExternal(r.abs);
}

// `baseDir` is the directory relative paths in this terminal actually resolve
// against (a session's own repo, or a console's cwd) — it can differ from the
// currently open folder, so it must ride along per-terminal rather than
// falling back to the global repo path.
export function registerTerminalLinks(term, baseDir) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!bufLine) return callback(undefined);
      const text = bufLine.translateToString(true);
      const links = findTerminalLinks(text).map((f) => {
        const link = {
          text: f.raw,
          range: { start: { x: f.start + 1, y }, end: { x: f.end, y } },
          // Decorated only if Ctrl is already down at hover time; once xterm
          // marks this link hovered it swaps in live decoration setters, and the
          // key listeners flip them — so the link lights up whenever Ctrl is held
          // over it, no matter which happened first.
          decorations: { pointerCursor: linkModDown, underline: linkModDown },
          activate: (event) => {
            if (!(onMac ? event.metaKey : event.ctrlKey)) return; // plain clicks pass through
            event.preventDefault();
            openTerminalLink(f.kind, f.raw, baseDir);
          },
        };
        link.hover = () => { hoveredLink = link; };
        link.leave = () => { if (hoveredLink === link) hoveredLink = null; };
        return link;
      });
      callback(links.length ? links : undefined);
    },
  });
}
