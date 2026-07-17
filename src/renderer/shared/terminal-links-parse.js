import { extOf, IMG_EXT, AUDIO_EXT, VIDEO_EXT, VECTOR_EXT } from './ext.js';
import { EXT_LANG } from './highlight.js';

// Pure parsing for the terminal's Ctrl+click links: locate the URL and path spans
// in one rendered terminal line. The xterm/DOM/IPC glue (live decorations, hover
// tracking, routing a click to the viewer) lives in renderer/terminal-links.js.
// Kept here because the detection deliberately over-matches and then filters, so
// it is the subtle part worth unit-testing (see test/terminal-links.test.mjs).

export const URL_RE = /\bhttps?:\/\/[^\s)<>"'`]+/gi;
// A path-ish token: an optional drive/anchor, then path chars, with optional
// trailing :line[:col]. Over-matches plain words; looksLikePath() filters those.
export const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)*(?::\d+(?::\d+)?)?/g;

// Extensions that make a separator-less token (e.g. "renderer.js") a real link.
export const PATH_EXT = new Set([
  ...Object.keys(EXT_LANG), ...IMG_EXT, ...AUDIO_EXT, ...VIDEO_EXT, ...VECTOR_EXT,
  'txt', 'log', 'lock', 'env', 'conf', 'gd', 'tscn', 'tres', 'godot',
]);

export function looksLikePath(raw) {
  const core = raw.replace(/:\d+(?::\d+)?$/, '');
  if (core.length < 2) return false;
  if (/[\\/]/.test(core)) return true;        // has a separator -> treat as a path
  const ext = extOf(core);
  return !!ext && PATH_EXT.has(ext);          // bare filename with a known extension
}

// How many wrapped terminal rows may join into one logical line for link
// detection (6x the old single-row scan), so links that soft-wrap in a narrow
// terminal still resolve end to end.
export const MAX_LINK_ROWS = 6;

// Map a [start, end) span inside a stitched logical line back to per-row
// terminal coordinates. `rowLens` holds the text length of each stitched row;
// returns 0-based { startRow, startCol, endRow, endCol } with endCol pointing
// at the span's last character (inclusive), or null for an empty span.
export function mapSpanToRows(rowLens, start, end) {
  if (end <= start) return null;
  const locate = (offset) => {
    let row = 0, acc = 0;
    while (row < rowLens.length - 1 && offset >= acc + rowLens[row]) { acc += rowLens[row]; row++; }
    return { row, col: offset - acc };
  };
  const s = locate(start);
  const e = locate(end - 1);
  return { startRow: s.row, startCol: s.col, endRow: e.row, endCol: e.col };
}

// Find non-overlapping URL (first) then path matches in one terminal line.
export function findTerminalLinks(text) {
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
