import { evaluateFormula } from '../../shared/sheet-formula.js';
import { colToLetter, toA1, parseA1 } from '../../shared/sheet-model.js';
import { toModel, serialize, formatValue, key } from './workbook.js';
import { refreshGit } from '../../git-pane.js';
import { t } from '../../../i18n/index.js';

// --- spreadsheet viewer: CSV / XLSX preview + editor ---
// Opens tabular files in an editable grid with sheet tabs, a formula bar, live
// formula recalculation (the dependency-free engine in shared/sheet-formula.js),
// number formats, and save-back to disk. SheetJS does the file I/O and is
// dynamically imported so the library never costs app startup. The grid is a
// plain <table> (sticky header row + row-number column via CSS); edits live in
// memory until Save / Ctrl+S, mirroring the text file editor.

const view = document.getElementById('sheet-view');
const body = document.getElementById('sheet-body');
const tabsEl = document.getElementById('sheet-tabs');
const fileLabel = document.getElementById('sheet-file');
const nameBox = document.getElementById('sheet-name-box');
const formulaBox = document.getElementById('sheet-formula-box');
const saveBtn = document.getElementById('sheet-save');
const boldBtn = document.getElementById('sheet-bold');
const italicBtn = document.getElementById('sheet-italic');
const numFmtSel = document.getElementById('sheet-numfmt');
const openExtBtn = document.getElementById('sheet-open-ext');

const PAD_ROWS = 24, PAD_COLS = 6;     // blank room past the used range for new data
const MAX_ROWS = 4000, MAX_COLS = 256; // render caps so a huge sheet can't freeze the UI
const DEFAULT_COL_W = 84;

let XLSX = null;          // the SheetJS namespace, loaded once on first open
let state = null;         // { file, ext, model, dirty, sel, editing, tdMap, computed, truncated }

export function hideSheet() {
  if (state && state.keydown) document.removeEventListener('keydown', state.keydown, true);
  view.style.display = 'none';
  body.innerHTML = '';
  tabsEl.innerHTML = '';
  state = null;
}

export async function showSheet(file, ext) {
  view.style.display = 'flex';
  fileLabel.textContent = file;
  body.innerHTML = `<div class="sheet-loading">${t('sheet.loading')}</div>`;
  tabsEl.innerHTML = '';
  resetToolbar();

  try {
    if (!XLSX) XLSX = await import('xlsx');
  } catch (e) {
    body.innerHTML = `<div class="sheet-error">${esc(t('sheet.loadFailed'))}: ${esc(e.message || e)}</div>`;
    return;
  }

  const isCsv = ext === 'csv' || ext === 'tsv';
  const r = isCsv ? await window.api.readText(file) : await window.api.readAsset(file);
  if (!r.ok) { body.innerHTML = `<div class="sheet-error">${esc(r.error || t('sheet.readFailed'))}</div>`; return; }

  let model;
  try {
    model = isCsv ? toModel(XLSX, r.text, 'string') : toModel(XLSX, r.base64, 'base64');
  } catch (e) {
    body.innerHTML = `<div class="sheet-error">${esc(t('sheet.parseFailed'))}: ${esc(e.message || e)}</div>`;
    return;
  }

  if (state && state.keydown) document.removeEventListener('keydown', state.keydown, true);
  state = { file, ext, model, dirty: false, sel: null, editing: null, tdMap: new Map(), computed: null, truncated: false };
  state.keydown = onKeydown;
  document.addEventListener('keydown', onKeydown, true);
  saveBtn.hidden = false;
  setDirty(false);
  openExtBtn.onclick = () => window.api.openAssetExternal(file);

  renderTabs();
  renderGrid();
  select(0, 0);
}

function sheet() { return state.model.sheets[state.model.active]; }
function cellAt(c, r) { return sheet().cells.get(key(c, r)) || null; }

// ── recompute ────────────────────────────────────────────────────────────────
// Build a "c,r" → computed-value map for every formula cell on a sheet, with
// memoization and cycle detection (a cell referenced while it's still being
// evaluated resolves to #REF!). Literals are read straight from cell.v.
function computeSheet(s) {
  const cache = new Map();
  const visiting = new Set();
  const ctx = {
    getCell(c, r) {
      const k = key(c, r);
      const cell = s.cells.get(k);
      if (!cell) return null;
      if (cell.f == null) return cell.v == null ? null : cell.v;
      if (cache.has(k)) return cache.get(k);
      if (visiting.has(k)) return '#REF!';
      visiting.add(k);
      const v = evaluateFormula(cell.f, ctx);
      visiting.delete(k);
      cache.set(k, v);
      return v;
    },
  };
  for (const [k, cell] of s.cells) {
    if (cell.f != null) { const [c, r] = k.split(',').map(Number); ctx.getCell(c, r); }
  }
  return cache;
}

function recompute() { state.computed = computeSheet(sheet()); }

// The value to show in a cell: a formula's computed result, else the literal,
// formatted through the cell's number format.
function displayValue(c, r) {
  const cell = cellAt(c, r);
  if (!cell) return '';
  const val = cell.f != null ? (state.computed ? state.computed.get(key(c, r)) : cell.v) : cell.v;
  return formatValue(XLSX, cell.z, val);
}

// ── grid rendering ───────────────────────────────────────────────────────────
function renderGrid() {
  const s = sheet();
  recompute();
  state.tdMap.clear();

  const usedRows = Math.max(s.nRows, 1) + PAD_ROWS;
  const usedCols = Math.max(s.nCols, 1) + PAD_COLS;
  const nRows = Math.min(usedRows, MAX_ROWS);
  const nCols = Math.min(usedCols, MAX_COLS);
  state.truncated = usedRows > MAX_ROWS || usedCols > MAX_COLS;
  state.nRows = nRows; state.nCols = nCols;

  // Cells covered by a merge (but not its top-left anchor) are not rendered.
  const covered = new Set();
  const anchorSpan = new Map();
  for (const m of s.merges) {
    anchorSpan.set(key(m.c1, m.r1), { cs: m.c2 - m.c1 + 1, rs: m.r2 - m.r1 + 1 });
    for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (!(c === m.c1 && r === m.r1)) covered.add(key(c, r));
  }

  const table = document.createElement('table');
  table.className = 'sheet-table';

  const colgroup = document.createElement('colgroup');
  colgroup.appendChild(document.createElement('col')); // row-number column
  for (let c = 0; c < nCols; c++) {
    const col = document.createElement('col');
    col.style.width = (s.cols[c] || DEFAULT_COL_W) + 'px';
    colgroup.appendChild(col);
  }
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  hr.appendChild(corner());
  for (let c = 0; c < nCols; c++) {
    const th = document.createElement('th');
    th.className = 'sheet-colhead';
    th.textContent = colToLetter(c);
    th.dataset.c = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (let r = 0; r < nRows; r++) {
    const tr = document.createElement('tr');
    const rh = document.createElement('th');
    rh.className = 'sheet-rowhead';
    rh.textContent = r + 1;
    rh.dataset.r = r;
    tr.appendChild(rh);
    for (let c = 0; c < nCols; c++) {
      if (covered.has(key(c, r))) continue;
      const td = document.createElement('td');
      td.className = 'sheet-cell';
      td.dataset.c = c; td.dataset.r = r;
      const span = anchorSpan.get(key(c, r));
      if (span) { td.colSpan = span.cs; td.rowSpan = span.rs; }
      paintCell(td, c, r);
      state.tdMap.set(key(c, r), td);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  body.innerHTML = '';
  body.appendChild(table);
  if (state.truncated) {
    const note = document.createElement('div');
    note.className = 'sheet-trunc-note';
    note.textContent = t('sheet.truncated');
    body.appendChild(note);
  }
  table.addEventListener('mousedown', onCellMouseDown);
  table.addEventListener('mouseover', onCellMouseOver);
  table.addEventListener('dblclick', onCellDblClick);
}

function corner() { const th = document.createElement('th'); th.className = 'sheet-corner'; return th; }

// Paint one cell's text + style. Numbers right-align unless overridden.
function paintCell(td, c, r) {
  const cell = cellAt(c, r);
  const text = displayValue(c, r);
  td.textContent = text;
  td.className = 'sheet-cell';
  const computed = cell && cell.f != null && state.computed ? state.computed.get(key(c, r)) : (cell ? cell.v : null);
  const isNum = typeof computed === 'number';
  td.style.cssText = '';
  if (cell && cell.s) {
    const st = cell.s;
    if (st.bold) td.style.fontWeight = 'bold';
    if (st.italic) td.style.fontStyle = 'italic';
    if (st.underline) td.style.textDecoration = 'underline';
    if (st.color) td.style.color = st.color;
    if (st.bg) td.style.background = st.bg;
    if (st.align) td.style.textAlign = st.align;
    else if (isNum) td.style.textAlign = 'right';
  } else if (isNum) {
    td.style.textAlign = 'right';
  }
  if (typeof computed === 'string' && computed.startsWith('#')) td.classList.add('sheet-cell-err');
}

function repaint(c, r) { const td = state.tdMap.get(key(c, r)); if (td) paintCell(td, c, r); }

// Repaint every rendered cell (after an edit that may ripple through formulas).
function repaintAll() {
  recompute();
  for (const [k, td] of state.tdMap) { const [c, r] = k.split(',').map(Number); paintCell(td, c, r); }
}

// ── selection ────────────────────────────────────────────────────────────────
function select(c, r, extend = false) {
  if (!state.sel || !extend) state.sel = { ac: c, ar: r, fc: c, fr: r };
  else { state.sel.fc = c; state.sel.fr = r; }
  paintSelection();
  syncToolbarToSelection();
}

function selRect() {
  const s = state.sel;
  return { c1: Math.min(s.ac, s.fc), r1: Math.min(s.ar, s.fr), c2: Math.max(s.ac, s.fc), r2: Math.max(s.ar, s.fr) };
}

function paintSelection() {
  for (const td of body.querySelectorAll('.sheet-cell.sel, .sheet-cell.active')) td.classList.remove('sel', 'active');
  for (const th of body.querySelectorAll('.sheet-colhead.hl, .sheet-rowhead.hl')) th.classList.remove('hl');
  if (!state.sel) return;
  const { c1, r1, c2, r2 } = selRect();
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) { const td = state.tdMap.get(key(c, r)); if (td) td.classList.add('sel'); }
  const active = state.tdMap.get(key(state.sel.ac, state.sel.ar));
  if (active) { active.classList.add('active'); active.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  for (let c = c1; c <= c2; c++) { const th = body.querySelector(`.sheet-colhead[data-c="${c}"]`); if (th) th.classList.add('hl'); }
  for (let r = r1; r <= r2; r++) { const th = body.querySelector(`.sheet-rowhead[data-r="${r}"]`); if (th) th.classList.add('hl'); }
}

// Mirror the active cell into the name box + formula bar.
function syncToolbarToSelection() {
  if (!state.sel) return;
  const { ac, ar } = state.sel;
  nameBox.value = toA1(ac, ar);
  const cell = cellAt(ac, ar);
  formulaBox.value = cell ? (cell.f != null ? '=' + cell.f : (cell.v == null ? '' : String(cell.v))) : '';
  const st = cell && cell.s;
  boldBtn.classList.toggle('active', !!(st && st.bold));
  italicBtn.classList.toggle('active', !!(st && st.italic));
  numFmtSel.value = (cell && cell.z) || '';
}

// ── mouse ────────────────────────────────────────────────────────────────────
function cellCoords(el) {
  const td = el.closest('.sheet-cell');
  if (!td) return null;
  return { c: Number(td.dataset.c), r: Number(td.dataset.r) };
}

let dragging = false;
function onCellMouseDown(e) {
  const colHead = e.target.closest('.sheet-colhead');
  const rowHead = e.target.closest('.sheet-rowhead');
  if (colHead) { selectColumn(Number(colHead.dataset.c), e.shiftKey); return; }
  if (rowHead) { selectRow(Number(rowHead.dataset.r), e.shiftKey); return; }
  const co = cellCoords(e.target);
  if (!co) return;
  commitEdit();
  if (e.button === 2) { if (!inSelection(co.c, co.r)) select(co.c, co.r); showContextMenu(e); return; }
  select(co.c, co.r, e.shiftKey);
  dragging = true;
}
function onCellMouseOver(e) {
  if (!dragging) return;
  const co = cellCoords(e.target);
  if (co) select(co.c, co.r, true);
}
document.addEventListener('mouseup', () => { dragging = false; });
function onCellDblClick(e) { const co = cellCoords(e.target); if (co) beginEdit(co.c, co.r); }

function selectColumn(c, extend) {
  commitEdit();
  state.sel = { ac: c, ar: 0, fc: c, fr: state.nRows - 1 };
  if (extend) state.sel.ar = 0;
  paintSelection(); syncToolbarToSelection();
}
function selectRow(r, extend) {
  commitEdit();
  state.sel = { ac: 0, ar: r, fc: state.nCols - 1, fr: r };
  if (extend) state.sel.ac = 0;
  paintSelection(); syncToolbarToSelection();
}
function inSelection(c, r) { if (!state.sel) return false; const s = selRect(); return c >= s.c1 && c <= s.c2 && r >= s.r1 && r <= s.r2; }

// ── editing ──────────────────────────────────────────────────────────────────
function beginEdit(c, r, seed) {
  commitEdit();
  select(c, r);
  const td = state.tdMap.get(key(c, r));
  if (!td) return;
  const cell = cellAt(c, r);
  const input = document.createElement('input');
  input.className = 'sheet-editor';
  input.value = seed != null ? seed : (cell ? (cell.f != null ? '=' + cell.f : (cell.v == null ? '' : String(cell.v))) : '');
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  if (seed == null) input.select(); else input.setSelectionRange(input.value.length, input.value.length);
  state.editing = { c, r, input };
  input.addEventListener('input', () => { formulaBox.value = input.value; });
  // Clicking away (toolbar, Save, another pane) commits rather than dropping the edit.
  input.addEventListener('blur', () => { if (state && state.editing && state.editing.input === input) commitEdit(); });
}

function commitEdit() {
  if (!state.editing) return;
  const { c, r, input } = state.editing;
  state.editing = null;
  setCellInput(c, r, input.value);
  repaintAll();
}

function cancelEdit() {
  if (!state.editing) return;
  const { c, r } = state.editing;
  state.editing = null;
  repaint(c, r);
}

// Apply a raw text entry to a cell: '=' → formula, numeric → number,
// TRUE/FALSE → boolean, empty → clear, else string. Preserves style/format.
function setCellInput(c, r, raw) {
  const k = key(c, r);
  const s = sheet();
  let cell = s.cells.get(k);
  const text = raw;
  const make = () => { if (!cell) { cell = {}; s.cells.set(k, cell); } return cell; };
  if (text === '') {
    if (cell) { delete cell.f; delete cell.v; if (!cell.s && !cell.z) s.cells.delete(k); }
  } else if (text[0] === '=') {
    make(); cell.f = text.slice(1); delete cell.v;
  } else {
    make(); delete cell.f;
    const trimmed = text.trim();
    const up = trimmed.toUpperCase();
    if (trimmed !== '' && !Number.isNaN(Number(trimmed)) && /^[-+]?[\d.eE]+$/.test(trimmed)) cell.v = Number(trimmed);
    else if (up === 'TRUE') cell.v = true;
    else if (up === 'FALSE') cell.v = false;
    else cell.v = text;
  }
  if (c + 1 > s.nCols) s.nCols = c + 1;
  if (r + 1 > s.nRows) s.nRows = r + 1;
  setDirty(true);
}

// ── keyboard ─────────────────────────────────────────────────────────────────
function onKeydown(e) {
  if (view.style.display === 'none' || !state) return;
  // The formula bar / name box own their keys (their own listeners handle
  // Enter/Escape); don't let the grid's capture-phase handler hijack typing.
  if (e.target === formulaBox || e.target === nameBox) return;
  const ed = state.editing;
  if (ed) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); move(0, 1); }
    else if (e.key === 'Tab') { e.preventDefault(); commitEdit(); move(e.shiftKey ? -1 : 1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) { e.preventDefault(); toggleStyle('bold'); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) { e.preventDefault(); toggleStyle('italic'); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) { copySelection(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteSelection(); return; }
  if (!state.sel) return;
  const { ac, ar } = state.sel;
  switch (e.key) {
    case 'ArrowUp': e.preventDefault(); move(0, -1, 0, e.shiftKey); break;
    case 'ArrowDown': e.preventDefault(); move(0, 1, 0, e.shiftKey); break;
    case 'ArrowLeft': e.preventDefault(); move(-1, 0, 0, e.shiftKey); break;
    case 'ArrowRight': e.preventDefault(); move(1, 0, 0, e.shiftKey); break;
    case 'Tab': e.preventDefault(); move(e.shiftKey ? -1 : 1, 0); break;
    case 'Enter': e.preventDefault(); beginEdit(ac, ar); break;
    case 'F2': e.preventDefault(); beginEdit(ac, ar); break;
    case 'Delete': case 'Backspace': e.preventDefault(); clearSelection(); break;
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); beginEdit(ac, ar, e.key); }
  }
}

// dc/dr: arrow/tab delta. wrapCol/wrapRow let Enter-after-edit advance a row and
// Tab advance a column with the same call shape.
function move(dc, dr, wrapRow = 0, extend = false) {
  const s = state.sel;
  let c = Math.max(0, Math.min(state.nCols - 1, s.fc + dc));
  let r = Math.max(0, Math.min(state.nRows - 1, s.fr + dr + wrapRow));
  select(c, r, extend);
}

// ── formatting / clipboard ───────────────────────────────────────────────────
function eachSelected(fn) {
  const { c1, r1, c2, r2 } = selRect();
  for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) fn(c, r);
}
function ensureCell(c, r) { const k = key(c, r); let cell = sheet().cells.get(k); if (!cell) { cell = {}; sheet().cells.set(k, cell); } return cell; }

function toggleStyle(prop) {
  const a = cellAt(state.sel.ac, state.sel.ar);
  const turnOn = !(a && a.s && a.s[prop]);
  eachSelected((c, r) => { const cell = ensureCell(c, r); cell.s = cell.s || {}; if (turnOn) cell.s[prop] = true; else delete cell.s[prop]; });
  setDirty(true); repaintAll(); syncToolbarToSelection();
}

function applyNumFmt(z) {
  eachSelected((c, r) => { const cell = ensureCell(c, r); if (z) cell.z = z; else delete cell.z; });
  setDirty(true); repaintAll();
}

function clearSelection() {
  eachSelected((c, r) => { const cell = cellAt(c, r); if (cell) { delete cell.f; delete cell.v; if (!cell.s && !cell.z) sheet().cells.delete(key(c, r)); } });
  setDirty(true); repaintAll();
}

// Copy as TSV (round-trips through Excel/Sheets and our own paste).
function copySelection() {
  const { c1, r1, c2, r2 } = selRect();
  const rows = [];
  for (let r = r1; r <= r2; r++) {
    const line = [];
    for (let c = c1; c <= c2; c++) {
      const cell = cellAt(c, r);
      line.push(cell ? (cell.f != null ? '=' + cell.f : (cell.v == null ? '' : String(cell.v))) : '');
    }
    rows.push(line.join('\t'));
  }
  window.api.clipboardWrite(rows.join('\n'));
}

async function pasteSelection() {
  const text = await window.api.clipboardRead();
  if (!text) return;
  const { ac, ar } = state.sel;
  const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (rows.length && rows[rows.length - 1] === '') rows.pop();
  rows.forEach((line, dr) => line.split('\t').forEach((val, dc) => setCellInput(ac + dc, ar + dr, val)));
  repaintAll();
}

// ── context menu (insert / delete rows & columns) ────────────────────────────
let menuEl = null;
function showContextMenu(e) {
  hideContextMenu();
  const { c1, r1 } = selRect();
  menuEl = document.createElement('div');
  menuEl.className = 'sheet-menu';
  const item = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { hideContextMenu(); fn(); }; menuEl.appendChild(b); };
  item(t('sheet.insertRowAbove'), () => insertRows(r1, 1));
  item(t('sheet.insertRowBelow'), () => insertRows(r1 + 1, 1));
  item(t('sheet.deleteRow'), () => deleteRows());
  item(t('sheet.insertColLeft'), () => insertCols(c1, 1));
  item(t('sheet.insertColRight'), () => insertCols(c1 + 1, 1));
  item(t('sheet.deleteCol'), () => deleteCols());
  document.body.appendChild(menuEl);
  menuEl.style.left = e.clientX + 'px';
  menuEl.style.top = e.clientY + 'px';
  setTimeout(() => document.addEventListener('mousedown', hideContextMenu, { once: true }), 0);
}
function hideContextMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

// Row/column structural edits shift every cell's stored coordinate. Formulas are
// NOT re-pointed (a known ceiling — documented), so a reference past the edit can
// drift; values and layout move correctly.
function shiftCells(predicate, remap) {
  const s = sheet();
  const next = new Map();
  for (const [k, cell] of s.cells) {
    const [c, r] = k.split(',').map(Number);
    if (predicate(c, r)) { const nk = remap(c, r); if (nk) next.set(nk, cell); }
    else next.set(k, cell);
  }
  s.cells = next;
}
function insertRows(at, n) {
  shiftCells((c, r) => r >= at, (c, r) => key(c, r + n));
  sheet().merges.forEach((m) => { if (m.r1 >= at) { m.r1 += n; m.r2 += n; } });
  sheet().nRows += n; setDirty(true); renderGrid(); select(state.sel.ac, Math.min(at, state.nRows - 1));
}
function insertCols(at, n) {
  shiftCells((c) => c >= at, (c, r) => key(c + n, r));
  sheet().cols.splice(at, 0, ...Array(n).fill(0));
  sheet().merges.forEach((m) => { if (m.c1 >= at) { m.c1 += n; m.c2 += n; } });
  sheet().nCols += n; setDirty(true); renderGrid(); select(Math.min(at, state.nCols - 1), state.sel.ar);
}
function deleteRows() {
  const { r1, r2 } = selRect(); const n = r2 - r1 + 1;
  shiftCells((c, r) => r >= r1, (c, r) => (r > r2 ? key(c, r - n) : null));
  sheet().nRows = Math.max(1, sheet().nRows - n); setDirty(true); renderGrid(); select(state.sel.ac, Math.min(r1, state.nRows - 1));
}
function deleteCols() {
  const { c1, c2 } = selRect(); const n = c2 - c1 + 1;
  shiftCells((c) => c >= c1, (c, r) => (c > c2 ? key(c - n, r) : null));
  sheet().cols.splice(c1, n);
  sheet().nCols = Math.max(1, sheet().nCols - n); setDirty(true); renderGrid(); select(Math.min(c1, state.nCols - 1), state.sel.ar);
}

// ── tabs ─────────────────────────────────────────────────────────────────────
function renderTabs() {
  tabsEl.innerHTML = '';
  state.model.sheets.forEach((s, i) => {
    const tab = document.createElement('button');
    tab.className = 'sheet-tab' + (i === state.model.active ? ' active' : '');
    tab.textContent = s.name;
    tab.onclick = () => { if (i === state.model.active) return; commitEdit(); state.model.active = i; renderTabs(); renderGrid(); select(0, 0); };
    tabsEl.appendChild(tab);
  });
}

// ── save / dirty ─────────────────────────────────────────────────────────────
function setDirty(d) {
  state.dirty = d;
  saveBtn.disabled = !d;
  saveBtn.classList.toggle('dirty', d);
  fileLabel.textContent = state.file + (d ? ' •' : '');
}

async function save() {
  if (!state || !state.dirty) return;
  commitEdit();
  const isCsv = state.ext === 'csv' || state.ext === 'tsv';
  const bookType = isCsv ? 'csv' : (['xls', 'xlsm', 'xlsb', 'ods'].includes(state.ext) ? state.ext : 'xlsx');
  let out;
  try { out = serialize(XLSX, state.model, bookType, computeSheet); }
  catch (e) { saveBtn.textContent = t('sheet.saveFailed'); console.error('sheet serialize failed:', e); return; }
  const r = isCsv ? await window.api.writeText(state.file, out) : await window.api.writeAsset(state.file, out);
  if (!r.ok) { saveBtn.textContent = t('sheet.saveFailed'); console.error('sheet save failed:', r.error); return; }
  setDirty(false);
  refreshGit();
}

// ── toolbar wiring ───────────────────────────────────────────────────────────
function resetToolbar() {
  nameBox.value = ''; formulaBox.value = '';
  boldBtn.classList.remove('active'); italicBtn.classList.remove('active'); numFmtSel.value = '';
}
boldBtn.onclick = () => { if (state) toggleStyle('bold'); };
italicBtn.onclick = () => { if (state) toggleStyle('italic'); };
numFmtSel.onchange = () => { if (state) applyNumFmt(numFmtSel.value); };
formulaBox.addEventListener('keydown', (e) => {
  if (!state || !state.sel) return;
  if (e.key === 'Enter') { e.preventDefault(); setCellInput(state.sel.ac, state.sel.ar, formulaBox.value); repaintAll(); move(0, 1); formulaBox.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); syncToolbarToSelection(); formulaBox.blur(); }
});
nameBox.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !state) return;
  const p = parseA1(nameBox.value);
  if (p) select(Math.min(p.col, state.nCols - 1), Math.min(p.row, state.nRows - 1));
  nameBox.blur();
});

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s) { return String(s).replace(/[&<>]/g, (c) => HTML_ESC[c]); }
