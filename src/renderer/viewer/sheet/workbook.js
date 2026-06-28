import { colToLetter, toA1 } from '../../shared/sheet-model.js';

// SheetJS glue for the spreadsheet viewer. Converts a parsed SheetJS workbook
// into our flat editing model and back, and formats values through SheetJS's
// number-format engine (SSF). The `XLSX` namespace is passed in by the caller —
// it is dynamically imported in index.js so the (large) library never costs app
// startup, and keeping it out of the import graph here lets the rest stay light.
//
// Model shape:
//   workbook = { sheets: [sheet], active }
//   sheet    = { name, cells: Map<"c,r", cell>, nCols, nRows, cols:[w], merges:[{c1,r1,c2,r2}] }
//   cell     = { v, f, z, s }   v=literal/cached value, f=formula (no '='), z=numfmt, s=style
//
// Styles (s) are read for display only — the SheetJS community build writes
// values, formulas, and number formats, but not fonts/fills/borders.

const key = (c, r) => c + ',' + r;

function readStyle(s) {
  if (!s) return null;
  const out = {};
  if (s.font) {
    if (s.font.bold) out.bold = true;
    if (s.font.italic) out.italic = true;
    if (s.font.underline) out.underline = true;
    if (s.font.color && s.font.color.rgb) out.color = '#' + String(s.font.color.rgb).slice(-6);
  }
  if (s.fill && s.fill.fgColor && s.fill.fgColor.rgb && s.fill.patternType !== 'none') {
    out.bg = '#' + String(s.fill.fgColor.rgb).slice(-6);
  }
  if (s.alignment && s.alignment.horizontal) out.align = s.alignment.horizontal;
  return Object.keys(out).length ? out : null;
}

// Build our editing model from raw file bytes. `type` is 'base64' (xlsx/binary)
// or 'string' (csv/tsv); SheetJS auto-detects the actual format from content.
export function toModel(XLSX, data, type) {
  const wb = XLSX.read(data, { type, cellStyles: true, cellFormula: true, cellNF: true, cellDates: false });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws['!ref'] || 'A1';
    const range = XLSX.utils.decode_range(ref);
    const cells = new Map();
    let nCols = range.e.c + 1, nRows = range.e.r + 1;
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const raw = ws[XLSX.utils.encode_cell({ c, r })];
        if (!raw) continue;
        const cell = {};
        if (raw.f != null) cell.f = String(raw.f);
        if (raw.v != null) cell.v = raw.v;
        if (raw.z) cell.z = raw.z;
        const st = readStyle(raw.s);
        if (st) cell.s = st;
        if (cell.f != null || cell.v != null || cell.s) cells.set(key(c, r), cell);
      }
    }
    const cols = (ws['!cols'] || []).map((co) => (co && (co.wpx || (co.wch && co.wch * 7))) || 0);
    const merges = (ws['!merges'] || []).map((m) => ({ c1: m.s.c, r1: m.s.r, c2: m.e.c, r2: m.e.r }));
    return { name, cells, nCols: Math.max(nCols, 1), nRows: Math.max(nRows, 1), cols, merges };
  });
  return { sheets: sheets.length ? sheets : [{ name: 'Sheet1', cells: new Map(), nCols: 1, nRows: 1, cols: [], merges: [] }], active: 0 };
}

// Format a computed value for display using the cell's number format. Falls back
// to a plain string when there's no format or SSF can't apply it.
export function formatValue(XLSX, z, value) {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (z && typeof value === 'number') {
    try { return XLSX.SSF.format(z, value); } catch { /* fall through to plain */ }
  }
  return String(value);
}

// Reconstruct a SheetJS worksheet for one model sheet. `computed` maps "c,r" →
// the cell's evaluated value so formula cells carry a fresh cached result.
function sheetToWs(XLSX, sheet, computed) {
  const ws = {};
  let maxC = 0, maxR = 0;
  for (const [k, cell] of sheet.cells) {
    const [c, r] = k.split(',').map(Number);
    const addr = toA1(c, r);
    const out = {};
    const val = cell.f != null && computed ? computed.get(k) : cell.v;
    if (cell.f != null) out.f = cell.f;
    if (val == null) { if (cell.f == null) continue; out.t = 's'; out.v = ''; }
    else if (typeof val === 'number') { out.t = 'n'; out.v = val; }
    else if (typeof val === 'boolean') { out.t = 'b'; out.v = val; }
    else { out.t = 's'; out.v = String(val); }
    if (cell.z) out.z = cell.z;
    ws[addr] = out;
    if (c > maxC) maxC = c;
    if (r > maxR) maxR = r;
  }
  ws['!ref'] = XLSX.utils.encode_range({ s: { c: 0, r: 0 }, e: { c: Math.max(maxC, 0), r: Math.max(maxR, 0) } });
  if (sheet.merges && sheet.merges.length) {
    ws['!merges'] = sheet.merges.map((m) => ({ s: { c: m.c1, r: m.r1 }, e: { c: m.c2, r: m.r2 } }));
  }
  if (sheet.cols && sheet.cols.some((w) => w)) ws['!cols'] = sheet.cols.map((w) => (w ? { wpx: w } : {}));
  return ws;
}

// Serialize the whole model to base64 (xlsx) or a string (csv) for writing back.
// `computeSheet(sheet)` returns the "c,r" → value map of evaluated formulas.
export function serialize(XLSX, model, bookType, computeSheet) {
  const wb = XLSX.utils.book_new();
  for (const sheet of model.sheets) {
    XLSX.utils.book_append_sheet(wb, sheetToWs(XLSX, sheet, computeSheet(sheet)), sheet.name.slice(0, 31));
  }
  if (bookType === 'csv') {
    return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[model.active] || wb.SheetNames[0]]);
  }
  return XLSX.write(wb, { type: 'base64', bookType });
}

// "c,r" key helper re-exported for the grid/coordinator.
export { key, colToLetter };
