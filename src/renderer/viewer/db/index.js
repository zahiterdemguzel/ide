import { refreshGit } from '../../git-pane.js';
import { t } from '../../../i18n/index.js';

// --- database viewer/editor (renderer) ---
// Opens SQLite-family database files in an editable grid: a sidebar of tables &
// views, a paged row grid with inline cell editing, add/delete row, and a SQL
// console. The actual database lives in the main process (sql.js); this module is
// pure UI over the db-* IPC calls. Recognized-but-non-SQLite formats (Access,
// DuckDB, …) render an informational panel instead of a broken grid. Edits live
// in the in-memory database until Save writes the file back, mirroring the text
// and spreadsheet editors.

const view = document.getElementById('db-view');
const fileLabel = document.getElementById('db-file');
const engineLabel = document.getElementById('db-engine');
const sidebar = document.getElementById('db-sidebar');
const bodyWrap = document.getElementById('db-body');
const gridEl = document.getElementById('db-grid');
const footerEl = document.getElementById('db-footer');
const infoEl = document.getElementById('db-info');
const saveBtn = document.getElementById('db-save');
const sqlToggle = document.getElementById('db-sql-toggle');
const openExtBtn = document.getElementById('db-open-ext');
const sqlPanel = document.getElementById('db-sql-panel');
const sqlInput = document.getElementById('db-sql-input');
const sqlRun = document.getElementById('db-sql-run');
const sqlStatus = document.getElementById('db-sql-status');
const sqlResult = document.getElementById('db-sql-result');

const LAST_PAGE = 1e6; // sentinel page number; openTable clamps it to the real last page

let state = null; // { file, engine, current: {table, meta, rows, page, total}, editing, keydown }

export function hideDb() {
  if (state && state.keydown) document.removeEventListener('keydown', state.keydown, true);
  hideContextMenu();
  view.style.display = 'none';
  sidebar.innerHTML = '';
  gridEl.innerHTML = '';
  footerEl.innerHTML = '';
  sqlResult.innerHTML = '';
  state = null;
}

export async function showDb(file) {
  view.style.display = 'flex';
  fileLabel.textContent = file;
  engineLabel.textContent = '';
  sidebar.innerHTML = '';
  gridEl.innerHTML = `<div class="db-loading">${esc(t('db.loading'))}</div>`;
  footerEl.innerHTML = '';
  sqlResult.innerHTML = '';
  sqlStatus.textContent = '';
  infoEl.hidden = true;
  bodyWrap.hidden = false;
  saveBtn.hidden = true;
  sqlToggle.hidden = true;
  closeSqlPanel();

  if (state && state.keydown) document.removeEventListener('keydown', state.keydown, true);
  state = { file, engine: null, current: null, editing: null, keydown: onKeydown };
  document.addEventListener('keydown', onKeydown, true);
  openExtBtn.onclick = () => window.api.openAssetExternal(file);

  const res = await window.api.dbOpen(file);
  if (!state || state.file !== file) return; // switched away while loading

  if (!res.ok) {
    if (res.editable === false && res.engine) renderInfo(res.engine);
    else renderError(res.error || t('db.openFailed'));
    return;
  }

  state.engine = res.engine;
  engineLabel.textContent = res.engine.label;
  sqlToggle.hidden = false;
  setDirty(res.dirty);
  renderSidebar(res.schema);
  if (res.schema.length) selectObject(res.schema[0].name);
  else gridEl.innerHTML = `<div class="db-empty">${esc(t('db.noTables'))}</div>`;
}

// A recognized non-SQLite engine: name it and explain in-app editing isn't
// available, with an "open externally" escape hatch — never a broken grid.
function renderInfo(engine) {
  bodyWrap.hidden = true;
  sqlToggle.hidden = true;
  infoEl.hidden = false;
  infoEl.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'db-info-engine';
  h.textContent = engine.label;
  const p = document.createElement('div');
  p.className = 'db-info-msg';
  p.textContent = t('db.notEditable');
  const btn = document.createElement('button');
  btn.className = 'db-info-open';
  btn.textContent = t('db.openExternal');
  btn.onclick = () => window.api.openAssetExternal(state.file);
  infoEl.append(h, p, btn);
}

function renderError(msg) {
  bodyWrap.hidden = true;
  infoEl.hidden = false;
  infoEl.innerHTML = '';
  const p = document.createElement('div');
  p.className = 'db-info-error';
  p.textContent = msg;
  infoEl.appendChild(p);
}

// ── sidebar: tables then views ───────────────────────────────────────────────
function renderSidebar(schema) {
  sidebar.innerHTML = '';
  for (const obj of schema) {
    const btn = document.createElement('button');
    btn.className = 'db-obj' + (obj.type === 'view' ? ' db-obj-view' : '');
    btn.dataset.name = obj.name;
    const icon = document.createElement('span');
    icon.className = 'db-obj-icon';
    icon.textContent = obj.type === 'view' ? '◫' : '▦';
    const name = document.createElement('span');
    name.className = 'db-obj-name';
    name.textContent = obj.name;
    btn.append(icon, name);
    btn.onclick = () => selectObject(obj.name);
    sidebar.appendChild(btn);
  }
}

function highlightSidebar(name) {
  for (const b of sidebar.querySelectorAll('.db-obj')) b.classList.toggle('active', b.dataset.name === name);
}

function selectObject(name) {
  highlightSidebar(name);
  openTable(name, 0);
}

// ── table grid ───────────────────────────────────────────────────────────────
async function openTable(name, page) {
  commitEdit();
  const res = await window.api.dbTable(state.file, name, page);
  if (!state || res == null) return;
  if (!res.ok) { gridEl.innerHTML = `<div class="db-error">${esc(res.error || t('db.readFailed'))}</div>`; footerEl.innerHTML = ''; return; }

  const maxPage = res.total > 0 ? Math.floor((res.total - 1) / res.pageSize) : 0;
  if (page > maxPage) { openTable(name, maxPage); return; } // clamp the LAST_PAGE sentinel

  // The rowid-alias column (a single INTEGER PRIMARY KEY) doubles as the rowid, so
  // editing it changes the row's identity — tracked so we can update it in place.
  const pkCols = res.columns.filter((c) => c.pk);
  const rowidAlias = (res.identity.kind === 'rowid' && pkCols.length === 1 && /INT/i.test(pkCols[0].type)) ? pkCols[0].name : null;

  const rows = res.rows.map((r) => ({
    rowid: r.rowid,
    values: Object.fromEntries(res.columns.map((c, i) => [c.name, r.cells[i]])),
  }));

  state.current = { table: name, meta: res, rows, page: res.page, total: res.total, rowidAlias };
  renderGrid();
  renderFooter();
}

function renderGrid() {
  const { meta, rows } = state.current;
  const table = document.createElement('table');
  table.className = 'db-table';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'db-rowhead';
  hr.appendChild(corner);
  meta.columns.forEach((col) => {
    const th = document.createElement('th');
    th.className = 'db-colhead';
    const nm = document.createElement('span');
    nm.className = 'db-col-name';
    nm.textContent = col.name + (col.pk ? ' 🔑' : '');
    const ty = document.createElement('span');
    ty.className = 'db-col-type';
    ty.textContent = col.type || '';
    th.append(nm, ty);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((row, r) => {
    const tr = document.createElement('tr');
    tr.dataset.r = r;
    const rh = document.createElement('th');
    rh.className = 'db-rowhead';
    rh.textContent = state.current.page * meta.pageSize + r + 1;
    tr.appendChild(rh);
    meta.columns.forEach((col) => {
      const td = document.createElement('td');
      td.className = 'db-cell';
      td.dataset.col = col.name;
      paintCell(td, row.values[col.name]);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  gridEl.innerHTML = '';
  if (!rows.length) gridEl.innerHTML = `<div class="db-empty">${esc(t('db.emptyTable'))}</div>`;
  else { gridEl.appendChild(table); }
  if (meta.editable) {
    table.addEventListener('dblclick', onGridDblClick);
    table.addEventListener('contextmenu', onGridContextMenu);
  }
}

function paintCell(td, value) {
  td.classList.remove('db-null', 'db-blob');
  if (value === null || value === undefined) { td.textContent = 'NULL'; td.classList.add('db-null'); }
  else if (value && typeof value === 'object' && '__blob' in value) {
    td.textContent = `[BLOB ${value.__blob} B]`; td.classList.add('db-blob');
  } else td.textContent = String(value);
}

function renderFooter() {
  const { meta, page, total, rows } = state.current;
  footerEl.innerHTML = '';

  const info = document.createElement('span');
  info.className = 'db-foot-info';
  if (total === 0) info.textContent = t('db.noRows');
  else {
    const first = page * meta.pageSize + 1;
    const last = page * meta.pageSize + rows.length;
    info.textContent = t('db.rowRange').replace('{first}', first).replace('{last}', last).replace('{total}', total.toLocaleString());
  }

  const nav = document.createElement('span');
  nav.className = 'db-foot-nav';
  const maxPage = total > 0 ? Math.floor((total - 1) / meta.pageSize) : 0;
  const prev = navButton('‹', page <= 0, () => openTable(meta.table, page - 1));
  const next = navButton('›', page >= maxPage, () => openTable(meta.table, page + 1));
  nav.append(prev, next);

  footerEl.append(info, nav);

  if (meta.editable) {
    const add = document.createElement('button');
    add.className = 'db-foot-btn';
    add.textContent = t('db.addRow');
    add.onclick = addRow;
    footerEl.appendChild(add);
  } else {
    const ro = document.createElement('span');
    ro.className = 'db-foot-readonly';
    ro.textContent = meta.objType === 'view' ? t('db.viewReadonly') : t('db.tableReadonly');
    footerEl.appendChild(ro);
  }
}

function navButton(label, disabled, fn) {
  const b = document.createElement('button');
  b.className = 'db-foot-btn db-foot-page';
  b.textContent = label;
  b.disabled = disabled;
  if (!disabled) b.onclick = fn;
  return b;
}

// ── inline cell editing ──────────────────────────────────────────────────────
function onGridDblClick(e) {
  const td = e.target.closest('.db-cell');
  if (!td || td.classList.contains('db-blob')) return; // BLOBs aren't editable inline
  beginEdit(td);
}

function beginEdit(td) {
  commitEdit();
  const r = Number(td.closest('tr').dataset.r);
  const col = td.dataset.col;
  const row = state.current.rows[r];
  const cur = row.values[col];
  const input = document.createElement('input');
  input.className = 'db-cell-editor';
  input.value = cur === null || cur === undefined ? '' : String(cur);
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();
  state.editing = { td, r, col, input };
  input.addEventListener('blur', () => { if (state && state.editing && state.editing.input === input) commitEdit(); });
}

async function commitEdit() {
  if (!state || !state.editing) return;
  const { td, r, col, input } = state.editing;
  state.editing = null;
  const row = state.current.rows[r];
  const newText = input.value;
  const oldVal = row.values[col];
  // No-op if the text matches what's already there (NULL shown as empty).
  const oldText = oldVal === null || oldVal === undefined ? '' : String(oldVal);
  if (newText === oldText) { paintCell(td, oldVal); return; }

  const res = await window.api.dbUpdateCell(state.file, state.current.table, row.rowid, row.values, col, newText);
  if (!res || !res.ok) { paintCell(td, oldVal); if (res) showCellError(res.error); return; }
  row.values[col] = res.value;
  if (col === state.current.rowidAlias) row.rowid = res.value; // INTEGER PK alias == rowid
  paintCell(td, res.value);
  setDirty(true);
}

function showCellError(msg) { flashStatus(t('db.editFailed') + ': ' + msg); }

// ── add / delete rows ────────────────────────────────────────────────────────
async function addRow() {
  commitEdit();
  const res = await window.api.dbInsertRow(state.file, state.current.table, {});
  if (!res || !res.ok) { flashStatus(t('db.insertFailed') + (res ? ': ' + res.error : '')); return; }
  setDirty(true);
  openTable(state.current.table, LAST_PAGE); // jump to the page holding the new row
}

async function deleteCurrentRow(r) {
  const row = state.current.rows[r];
  const res = await window.api.dbDeleteRow(state.file, state.current.table, row.rowid, row.values);
  if (!res || !res.ok) { flashStatus(t('db.deleteFailed') + (res ? ': ' + res.error : '')); return; }
  setDirty(true);
  openTable(state.current.table, state.current.page);
}

// ── right-click context menu (delete row) ────────────────────────────────────
let menuEl = null;
function onGridContextMenu(e) {
  const tr = e.target.closest('tr[data-r]');
  if (!tr) return;
  e.preventDefault();
  showContextMenu(e, Number(tr.dataset.r));
}
function showContextMenu(e, r) {
  hideContextMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'db-menu';
  const del = document.createElement('button');
  del.textContent = t('db.deleteRow');
  del.onclick = () => { hideContextMenu(); deleteCurrentRow(r); };
  menuEl.appendChild(del);
  document.body.appendChild(menuEl);
  menuEl.style.left = e.clientX + 'px';
  menuEl.style.top = e.clientY + 'px';
  setTimeout(() => document.addEventListener('mousedown', hideContextMenu, { once: true }), 0);
}
function hideContextMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }

// ── SQL console ──────────────────────────────────────────────────────────────
function openSqlPanel() { sqlPanel.hidden = false; sqlToggle.classList.add('active'); sqlInput.focus(); }
function closeSqlPanel() { sqlPanel.hidden = true; sqlToggle.classList.remove('active'); }
sqlToggle.onclick = () => { if (sqlPanel.hidden) openSqlPanel(); else closeSqlPanel(); };

async function runSql() {
  const sql = sqlInput.value.trim();
  if (!sql || !state) return;
  sqlStatus.textContent = t('db.running');
  const res = await window.api.dbQuery(state.file, sql);
  if (!state) return;
  if (!res.ok) { sqlStatus.textContent = ''; sqlResult.innerHTML = `<div class="db-error">${esc(res.error)}</div>`; return; }

  if (res.readonly) {
    sqlStatus.textContent = res.results.length && res.results[0].rows.length
      ? t('db.rowsReturned').replace('{n}', res.results[0].rows.length)
      : t('db.noRowsReturned');
  } else {
    sqlStatus.textContent = t('db.rowsAffected').replace('{n}', res.rowsModified);
    setDirty(true);
    renderSidebar(res.schema); // a write may have changed the schema
    if (state.current) {
      const stillThere = res.schema.some((o) => o.name === state.current.table);
      if (stillThere) { highlightSidebar(state.current.table); openTable(state.current.table, state.current.page); }
      else if (res.schema.length) selectObject(res.schema[0].name);
      else { gridEl.innerHTML = `<div class="db-empty">${esc(t('db.noTables'))}</div>`; footerEl.innerHTML = ''; }
    }
  }
  renderSqlResult(res.results);
}

function renderSqlResult(results) {
  sqlResult.innerHTML = '';
  const last = results[results.length - 1];
  if (!last || !last.columns.length) return;
  const table = document.createElement('table');
  table.className = 'db-table db-result-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  last.columns.forEach((c) => { const th = document.createElement('th'); th.className = 'db-colhead'; th.textContent = c; hr.appendChild(th); });
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  last.rows.slice(0, 1000).forEach((rowVals) => {
    const tr = document.createElement('tr');
    rowVals.forEach((v) => { const td = document.createElement('td'); td.className = 'db-cell'; paintCell(td, v); tr.appendChild(td); });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  sqlResult.appendChild(table);
  if (last.rows.length > 1000) {
    const note = document.createElement('div');
    note.className = 'db-result-note';
    note.textContent = t('db.resultTruncated');
    sqlResult.appendChild(note);
  }
}

sqlRun.onclick = runSql;
sqlInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); }
});

// ── save / dirty ─────────────────────────────────────────────────────────────
function setDirty(d) {
  if (!state) return;
  state.dirty = d;
  saveBtn.hidden = false;
  saveBtn.disabled = !d;
  saveBtn.classList.toggle('dirty', d);
  fileLabel.textContent = state.file + (d ? ' •' : '');
}

async function save() {
  if (!state || !state.dirty) return;
  commitEdit();
  const res = await window.api.dbSave(state.file);
  if (!res || !res.ok) { flashStatus(t('db.saveFailed') + (res ? ': ' + res.error : '')); return; }
  setDirty(false);
  refreshGit();
}
saveBtn.onclick = save;

let statusTimer = null;
function flashStatus(msg) {
  sqlStatus.textContent = msg;
  if (!sqlPanel.hidden) return; // already visible
  if (statusTimer) clearTimeout(statusTimer);
  // briefly surface the panel so an error/notice isn't lost when the console is closed
  openSqlPanel();
  statusTimer = setTimeout(() => { if (sqlInput.value.trim() === '') closeSqlPanel(); }, 4000);
}

// ── keyboard ─────────────────────────────────────────────────────────────────
function onKeydown(e) {
  if (view.style.display === 'none' || !state) return;
  if (state.editing) {
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); const { td, r, col } = state.editing; state.editing = null; paintCell(td, state.current.rows[r].values[col]); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
function esc(s) { return String(s).replace(/[&<>]/g, (c) => HTML_ESC[c]); }
