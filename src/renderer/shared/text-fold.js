// Case- and Unicode-aware folding shared by every in-app search surface: the
// explorer search bar, the editor's Ctrl+F find bar, and the Ctrl+P quick-open.
// They all fold the same way so "Şçöü", "şçöü" and "ŞÇÖÜ" are treated alike and
// matching "just works" for non-ASCII text.
//
// Plain String.prototype.toLowerCase already folds most accented letters
// (Ç→ç, Ö→ö, Ü→ü, Ş→ş …), but two things trip up naïve search:
//
//   1. A few uppercase letters lowercase to MORE than one UTF-16 code unit —
//      Turkish "İ" (U+0130) → "i̇" (i + combining dot). Lowercasing the whole
//      string then shifts every match offset after such a letter, so the editor
//      paints its find-highlights on the wrong characters and "find next"
//      lands off by one. (Many Turkish words start with İ — e.g. "İstanbul" —
//      so this is the common case, not an edge case.)
//
//   2. The same letter can lowercase to a different length, so a query can't be
//      compared by raw `.toLowerCase()` length either.
//
// fold() folds per code point and guarantees the result is the SAME length
// (in UTF-16 code units) as its input, so a match offset in the folded string
// maps straight back onto the original text — highlights and selections line up.
// When a code point's lowercase form would change length, its combining marks
// are dropped to bring it back to one unit; that also folds "İ"/"I" → "i", so a
// lowercase query like "istanbul" still finds "İstanbul".
export function fold(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    let lower = ch.toLowerCase();
    if (lower.length !== ch.length) {
      const stripped = lower.normalize('NFD').replace(/\p{M}/gu, '');
      lower = stripped.length === ch.length ? stripped : ch;
    }
    out += lower;
  }
  return out;
}
