// Breadcrumb helpers: which nested symbols (class › method › …) contain the
// caret, and a compact relative-time label for the inline blame. Pure, so both
// are unit-tested without Monaco.

function contains(range, line, column) {
  if (line < range.startLineNumber || line > range.endLineNumber) return false;
  if (line === range.startLineNumber && column < range.startColumn) return false;
  if (line === range.endLineNumber && column > range.endColumn) return false;
  return true;
}

// `symbols` is a Monaco-shaped DocumentSymbol tree ({ name, kind, range,
// selectionRange, children }); returns the chain from outermost to innermost.
export function symbolPathAt(symbols, line, column) {
  const chain = [];
  let level = symbols || [];
  for (;;) {
    const hit = level.find((s) => s.range && contains(s.range, line, column));
    if (!hit) return chain;
    chain.push(hit);
    level = hit.children || [];
  }
}

const UNITS = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['week', 7 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
];

// "3 days ago" in the given locale (Intl.RelativeTimeFormat); "now" under a minute.
export function relativeTime(timeMs, nowMs, locale = 'en') {
  const diff = Math.max(0, nowMs - timeMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (diff >= size) return rtf.format(-Math.floor(diff / size), unit);
  }
  return rtf.format(0, 'second');
}
