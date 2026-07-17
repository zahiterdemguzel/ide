import { findTerminalLinks, mapSpanToRows, MAX_LINK_ROWS } from './shared/terminal-links-parse.js';
import { isLinkModDown, subscribeLinkMod, onMac } from './link-mod.js';
import { openLink } from './link-open.js';

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
let hoveredLink = null; // the ILink xterm is currently hovering, or null

// Reflect the current modifier state onto the hovered link's decorations.
subscribeLinkMod((down) => {
  if (!hoveredLink) return;
  hoveredLink.decorations.underline = down;
  hoveredLink.decorations.pointerCursor = down;
});

// `baseDir` is the directory relative paths in this terminal actually resolve
// against (a session's own repo, or a console's cwd) — it can differ from the
// currently open folder, so it must ride along per-terminal rather than
// falling back to the global repo path.
export function registerTerminalLinks(term, baseDir) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      if (!buf.getLine(y - 1)) return callback(undefined);
      // Stitch soft-wrapped rows into one logical line (bounded to
      // MAX_LINK_ROWS) so a link cut by the terminal width still matches whole.
      let first = y - 1;
      while (first > 0 && buf.getLine(first)?.isWrapped && (y - 1) - first < MAX_LINK_ROWS - 1) first--;
      let last = y - 1;
      while (buf.getLine(last + 1)?.isWrapped && last - first < MAX_LINK_ROWS - 1) last++;
      const rowTexts = [];
      for (let i = first; i <= last; i++) {
        // Trim only the final row: intermediate rows wrapped because they were
        // full, so their trailing cells are real content.
        rowTexts.push(buf.getLine(i).translateToString(i === last));
      }
      const rowLens = rowTexts.map((t) => t.length);
      const text = rowTexts.join('');
      const links = findTerminalLinks(text).map((f) => {
        const span = mapSpanToRows(rowLens, f.start, f.end);
        if (!span) return null;
        const link = {
          text: f.raw,
          range: {
            start: { x: span.startCol + 1, y: first + span.startRow + 1 },
            end: { x: span.endCol + 1, y: first + span.endRow + 1 },
          },
          // Decorated only if Ctrl is already down at hover time; once xterm
          // marks this link hovered it swaps in live decoration setters, and the
          // key listeners flip them — so the link lights up whenever Ctrl is held
          // over it, no matter which happened first.
          decorations: { pointerCursor: isLinkModDown(), underline: isLinkModDown() },
          activate: (event) => {
            if (!(onMac ? event.metaKey : event.ctrlKey)) return; // plain clicks pass through
            event.preventDefault();
            openLink(f.kind, f.raw, baseDir);
          },
        };
        link.hover = () => { hoveredLink = link; };
        link.leave = () => { if (hoveredLink === link) hoveredLink = null; };
        return link;
      }).filter(Boolean);
      callback(links.length ? links : undefined);
    },
  });
}
