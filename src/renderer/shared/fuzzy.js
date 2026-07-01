// Pure, DOM-free fuzzy subsequence matcher for the Quick Open palette
// (renderer/quick-open.js). Kept Electron- and DOM-free so it can be unit-tested
// (see .claude/memory/testing.md) the same way as git-status.js.
//
// A candidate matches only when every query character appears in order (a
// subsequence). The score rewards the things that make a guess feel "right" in a
// file switcher: runs of consecutive characters, matches that land on a word or
// path boundary (a separator, a `.`/`_`/`-`, or a camelCase hump), and matches
// inside the file's basename rather than its parent directories. Ties break
// toward the shorter path and the earlier first match, so `app.js` beats
// `vendor/app.bundle.js` for the query "app".

import { fold } from './text-fold.js';

const BOUNDARY_BEFORE = /[\\/._\- ]/;

function basenameStart(target) {
  let i = target.length - 1;
  for (; i >= 0; i--) if (target[i] === '/' || target[i] === '\\') break;
  return i + 1; // 0 when there is no separator
}

// Score `target` against `query`. Returns { score, positions } (positions are the
// matched indices into `target`, for highlighting) or null when query is not a
// subsequence of target. An empty query matches everything with a neutral score.
export function fuzzyMatch(query, target) {
  // fold() is length-preserving, so positions into `t` index `target` directly
  // (quick-open highlights with target[i]).
  const q = fold(query).replace(/\s+/g, ''); // spaces are noise in a path
  if (!q) return { score: 0, positions: [] };
  const t = fold(target);
  const baseStart = basenameStart(target);

  const positions = [];
  let score = 0;
  let prevMatch = -2;
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let k = ti; k < t.length; k++) { if (t[k] === ch) { found = k; break; } }
    if (found === -1) return null;

    score += 1; // base point for the matched character
    if (found === prevMatch + 1) score += 6; // consecutive run

    const before = target[found - 1];
    if (found === 0) score += 9;
    else if (BOUNDARY_BEFORE.test(before)) score += 9; // start of a path segment / word
    else if (/[a-z]/.test(before) && /[A-Z]/.test(target[found])) score += 7; // camelCase hump

    if (found >= baseStart) score += 3; // inside the filename, not a parent dir

    positions.push(found);
    prevMatch = found;
    ti = found + 1;
  }

  // Tie-breakers: prefer the shorter path and an earlier first match. Small
  // enough not to overturn a genuinely better structural match.
  score -= target.length * 0.02;
  score -= positions[0] * 0.05;
  return { score, positions };
}

// Rank `items` (strings) by their match against `query`, best first, keeping at
// most `limit`. Each result is { item, positions }. An empty query returns the
// head of the list unscored, so opening the palette shows something immediately.
export function fuzzyFilter(query, items, limit = 100) {
  const q = (query || '').trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, positions: [] }));
  const scored = [];
  for (const item of items) {
    const m = fuzzyMatch(q, item);
    if (m) scored.push({ item, score: m.score, positions: m.positions });
  }
  scored.sort((a, b) =>
    b.score - a.score || a.item.length - b.item.length || (a.item < b.item ? -1 : 1));
  return scored.slice(0, limit).map(({ item, positions }) => ({ item, positions }));
}
