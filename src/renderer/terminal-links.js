import { extOf, IMG_EXT, AUDIO_EXT } from './shared/ext.js';
import { EXT_LANG } from './shared/highlight.js';
import { openFromTree, showWeb } from './viewer/center.js';

// --- terminal Ctrl+click links (file paths + web URLs) ---
// VS Code feel: links only light up while Ctrl (Cmd on mac) is held, so normal
// hover and drag-to-select are untouched. provideLinks is gated on that key
// state; activating a link routes to the file viewer or the inline browser.
let linkModDown = false;
const onMac = navigator.platform.toLowerCase().includes('mac');
window.addEventListener('keydown', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) linkModDown = true; });
window.addEventListener('keyup', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) linkModDown = false; });
window.addEventListener('blur', () => { linkModDown = false; });

const URL_RE = /\bhttps?:\/\/[^\s)<>"'`]+/gi;
// A path-ish token: an optional drive/anchor, then path chars, with optional
// trailing :line[:col]. Over-matches plain words; looksLikePath() filters those.
const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)*(?::\d+(?::\d+)?)?/g;

// Extensions that make a separator-less token (e.g. "renderer.js") a real link.
const PATH_EXT = new Set([
  ...Object.keys(EXT_LANG), ...IMG_EXT, ...AUDIO_EXT,
  'txt', 'log', 'lock', 'env', 'conf', 'gd', 'tscn', 'tres', 'godot',
]);

function looksLikePath(raw) {
  const core = raw.replace(/:\d+(?::\d+)?$/, '');
  if (core.length < 2) return false;
  if (/[\\/]/.test(core)) return true;        // has a separator -> treat as a path
  const ext = extOf(core);
  return !!ext && PATH_EXT.has(ext);          // bare filename with a known extension
}

// Find non-overlapping URL (first) then path matches in one terminal line.
function findTerminalLinks(text) {
  const out = [];
  const taken = new Array(text.length).fill(false);
  const scan = (re, kind, keep) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (keep && !keep(m[0])) continue;
      let free = true;
      for (let i = s; i < e; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      for (let i = s; i < e; i++) taken[i] = true;
      out.push({ start: s, end: e, raw: m[0], kind });
    }
  };
  scan(URL_RE, 'url');
  scan(PATH_RE, 'path', looksLikePath);
  return out;
}

async function openTerminalLink(kind, raw) {
  if (kind === 'url') { showWeb(raw); return; }
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw); // split a trailing :line[:col]
  const p = m ? m[1] : raw;
  const line = m ? Number(m[2]) : null;
  const r = await window.api.resolveLinkPath(p);
  if (!r || !r.ok || !r.isFile) return;
  if (r.inRepo) openFromTree(r.rel, line ? { line, term: null } : null);
  else window.api.openExternal(r.abs);
}

export function registerTerminalLinks(term) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      if (!linkModDown) return callback(undefined);
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!bufLine) return callback(undefined);
      const text = bufLine.translateToString(true);
      const links = findTerminalLinks(text).map((f) => ({
        text: f.raw,
        range: { start: { x: f.start + 1, y }, end: { x: f.end, y } },
        decorations: { pointerCursor: true, underline: true },
        activate: (event) => { event.preventDefault(); openTerminalLink(f.kind, f.raw); },
      }));
      callback(links.length ? links : undefined);
    },
  });
}
