// Pure spreadsheet address math, shared by the grid UI and the formula engine.
// Everything here is 0-based internally (col 0 = "A", row 0 = "1"); only the
// A1-string helpers cross into the 1-based world the user sees. No DOM, no deps —
// unit-tested in test/sheet-model.test.mjs.

// 0-based column index → spreadsheet letters: 0→"A", 25→"Z", 26→"AA".
export function colToLetter(col) {
  let n = col, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Spreadsheet letters → 0-based column index. "A"→0, "AA"→26. Case-insensitive.
export function letterToCol(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// "B3" / "$B$3" → { col, row, absCol, absRow } (0-based), or null if not a ref.
// The `$` anchors are remembered so fill/insert can rewrite relative refs only.
const A1_RE = /^(\$?)([A-Za-z]+)(\$?)(\d+)$/;
export function parseA1(s) {
  const m = A1_RE.exec(String(s).trim());
  if (!m) return null;
  return {
    col: letterToCol(m[2]),
    row: Number(m[4]) - 1,
    absCol: m[1] === '$',
    absRow: m[3] === '$',
  };
}

// 0-based (col,row) → "B3". `absCol`/`absRow` add the `$` anchors back.
export function toA1(col, row, absCol = false, absRow = false) {
  return (absCol ? '$' : '') + colToLetter(col) + (absRow ? '$' : '') + (row + 1);
}

// "A1:B3" → { c1, r1, c2, r2 } with c1<=c2, r1<=r2 (normalized), or null.
// A bare single ref "A1" is treated as the 1×1 range A1:A1.
export function parseRange(s) {
  const parts = String(s).trim().split(':');
  if (parts.length === 1) {
    const a = parseA1(parts[0]);
    return a ? { c1: a.col, r1: a.row, c2: a.col, r2: a.row } : null;
  }
  if (parts.length !== 2) return null;
  const a = parseA1(parts[0]); const b = parseA1(parts[1]);
  if (!a || !b) return null;
  return {
    c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row),
    c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row),
  };
}
