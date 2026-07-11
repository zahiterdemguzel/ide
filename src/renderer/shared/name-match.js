// Whitespace-term name matching shared by surfaces that filter a list by a typed
// query. This mirrors the explorer's filename search (main's `search-names`): the
// query is folded (NFC + case-insensitive, via text-fold) and split on whitespace
// into terms that ALL must match the haystack. A term of "*.png" or ".png" matches
// by suffix; any other term is a plain substring. Kept DOM- and Electron-free so
// the matching is unit-tested on its own.
import { fold } from './text-fold.js';

// Compile a raw query string into the term list `matchesTerms` consumes. Empty
// when the query is blank, so a blank query matches everything (the caller skips
// filtering). Identical term shape to `search-names` so behaviour lines up.
export function compileQuery(q) {
  const needle = fold(String(q == null ? '' : q).trim());
  if (!needle) return [];
  return needle.split(/\s+/).map((t) => {
    const ext = /^\*?\.([a-z0-9]+)$/.exec(t);
    return ext ? { suffix: '.' + ext[1] } : { sub: t };
  });
}

// True when the folded haystack satisfies every compiled term.
export function matchesTerms(terms, haystack) {
  const hay = fold(haystack);
  return terms.every((t) => (t.suffix ? hay.endsWith(t.suffix) : hay.includes(t.sub)));
}

// Convenience one-shot: does `haystack` match raw query `q`? A blank query always
// matches (no filter). Use compileQuery once + matchesTerms in a loop when
// filtering many items against the same query.
export function matchesQuery(haystack, q) {
  const terms = compileQuery(q);
  return terms.length === 0 || matchesTerms(terms, haystack);
}
