// Pure text-search helpers backing the file editor's find bar (Ctrl+F). Kept
// Electron- and DOM-free so the matching/navigation logic is unit-tested; the
// editor (viewer/file.js) owns the textarea selection + scrolling around it.

// All non-overlapping occurrences of `query` in `text`, as { start, end } index
// pairs (end is exclusive, so text.slice(start, end) === the match). Empty or
// whitespace-only queries match nothing. Case-insensitive unless `caseSensitive`.
export function findMatches(text, query, caseSensitive = false) {
  if (!query) return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out = [];
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: i, end: i + needle.length });
    from = i + needle.length; // non-overlapping
  }
  return out;
}

// Index of the match to land on when the bar first opens or the query changes:
// the first match at or after the caret, wrapping to the first match. -1 when
// there are no matches. This keeps "find next" feeling anchored to the cursor.
export function nearestMatch(matches, caret) {
  if (!matches.length) return -1;
  for (let i = 0; i < matches.length; i++) {
    if (matches[i].start >= caret) return i;
  }
  return 0; // caret is past the last match — wrap to the top
}

// Step the active match index by `dir` (+1 next, -1 prev) with wraparound.
// Returns -1 for an empty match list.
export function stepMatch(current, count, dir) {
  if (count <= 0) return -1;
  return ((current + dir) % count + count) % count;
}
