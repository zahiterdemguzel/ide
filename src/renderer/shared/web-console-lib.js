// Pure core of the inline browser's console drawer (src/renderer/viewer/web-console.js).
// DOM-free so it can be unit-tested: level naming, the consecutive-repeat
// collapsing and ring cap of the entry list, and the filter predicate.

// Chromium reports console levels as small integers on `console-message`
// (Electron 31) but newer builds pass a string — both shapes map here.
const LEVEL_BY_INDEX = ['verbose', 'info', 'warning', 'error'];
const LEVEL_ALIASES = {
  verbose: 'verbose', debug: 'verbose', log: 'info', info: 'info',
  warn: 'warning', warning: 'warning', error: 'error',
};

export function levelName(level) {
  if (typeof level === 'number') return LEVEL_BY_INDEX[level] || 'info';
  return LEVEL_ALIASES[String(level || '').toLowerCase()] || 'info';
}

// The kinds a row can be: guest console output, the echo of a typed expression,
// and the value it evaluated to. Kinds other than 'log' never collapse into a
// repeat count — two identical inputs are two separate interactions.
export const MAX_ENTRIES = 1000;

export function makeEntry(kind, level, text, source = '') {
  return { kind, level: levelName(level), text: String(text ?? ''), source, count: 1 };
}

// Append with Chrome's two behaviors: an identical consecutive message bumps a
// repeat count instead of adding a row, and the list is capped (oldest dropped).
export function appendEntry(entries, entry, max = MAX_ENTRIES) {
  const last = entries[entries.length - 1];
  if (last && entry.kind === 'log' && last.kind === 'log'
      && last.level === entry.level && last.text === entry.text) {
    last.count++;
    return { entries, added: false };
  }
  entries.push(entry);
  if (entries.length > max) entries.splice(0, entries.length - max);
  return { entries, added: true };
}

// Level filter as Chrome's dropdown works: a chosen level shows only that level,
// 'all' shows everything. Input/result rows are always shown — they are the
// user's own interaction, not page output.
export function matchesFilter(entry, { level = 'all', text = '' } = {}) {
  const q = text.trim().toLowerCase();
  if (q && !entry.text.toLowerCase().includes(q)) return false;
  if (level === 'all' || entry.kind !== 'log') return true;
  return entry.level === level;
}

export const countsByLevel = (entries) => ({
  error: entries.filter((e) => e.kind === 'log' && e.level === 'error').length,
  warning: entries.filter((e) => e.kind === 'log' && e.level === 'warning').length,
});

// Render an evaluated value the way a console does: strings unquoted at the top
// level, everything else JSON-ish, cycles and non-serializable values tolerated.
export function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      return typeof v === 'function' ? `ƒ ${v.name || 'anonymous'}()` : v;
    }, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
