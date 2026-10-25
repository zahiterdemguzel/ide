// Pure, DOM-free core of the searchable option list behind pickOption() — the
// launch.json `pickString` input. prompt.js owns the dialog DOM and key events;
// the ranking and the active-row arithmetic live here so they can be unit-tested.

import { fuzzyMatch } from './fuzzy.js';

// Options arrive as plain strings or { label, value } (VS Code's pickString
// allows both). Flatten to one shape and mark the config's default.
export function normalizeOptions(options = [], def) {
  return options.map((opt) => {
    const isObject = typeof opt === 'object' && opt !== null;
    const value = isObject ? opt.value : opt;
    const label = String(isObject ? (opt.label || opt.value) : opt);
    return { label, value, isDefault: def !== undefined && value === def };
  });
}

// Filter + rank options by `query`, best first. An empty query keeps the
// config's own order (its author chose it). Equal scores keep that order too,
// so near-identical names don't shuffle as you type. Each result is
// { option, positions } — positions index option.label, for highlighting.
export function rankOptions(query, options) {
  const q = (query || '').trim();
  if (!q) return options.map((option) => ({ option, positions: [] }));
  const scored = [];
  options.forEach((option, index) => {
    const m = fuzzyMatch(q, option.label);
    if (m) scored.push({ option, positions: m.positions, score: m.score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map(({ option, positions }) => ({ option, positions }));
}

// Which row starts highlighted: the default when nothing is typed (Enter then
// accepts it, matching VS Code), otherwise the best match. -1 means no rows.
export function initialActiveIndex(ranked, query) {
  if (!ranked.length) return -1;
  if ((query || '').trim()) return 0;
  const def = ranked.findIndex((r) => r.option.isDefault);
  return def === -1 ? 0 : def;
}

// Move the highlight by `delta` rows, wrapping past either end like a menu.
export function stepActiveIndex(index, delta, count) {
  if (count <= 0) return -1;
  if (index < 0) return delta < 0 ? count - 1 : 0;
  return (((index + delta) % count) + count) % count;
}
