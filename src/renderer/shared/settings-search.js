// Matching for the Settings dialog's search box. Kept DOM-free so the rules —
// case- and accent-insensitive, every typed word must appear somewhere — are
// unit-tested rather than discovered by typing into the dialog.

// Lowercase and strip diacritics, so "senal" finds "señal" and "dil" finds "Dİl".
// The dotted/dotless Turkish i both fold to a plain "i".
export function normalizeSearchText(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/\s+/g, ' ')
    .trim();
}

// The query split into normalized words; an empty list means "no search".
export function searchTerms(query) {
  const normalized = normalizeSearchText(query);
  return normalized ? normalized.split(' ') : [];
}

// True when every term occurs in the haystack (in any order). No terms matches all,
// so an empty search box shows everything.
export function matchesSearch(haystack, terms) {
  if (!terms.length) return true;
  const text = normalizeSearchText(haystack);
  return terms.every((term) => text.includes(term));
}
