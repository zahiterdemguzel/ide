const { parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const {
  isSqliteBuffer, engineForFile, quoteIdent, quoteLiteral, rowIdentity,
  buildSelect, buildCount, buildUpdate, buildInsert, buildDelete,
  coerceInput, isReadOnlySql,
} = require('./db-sql');

// --- database viewer/editor (worker side) ---
// All sql.js work runs here, on a worker thread, so a slow query or a
// multi-megabyte database load never blocks the main process (which must stay
// responsive to relay PTY output and every other IPC). db.js is the thin
// main-side proxy: it forwards each renderer call as a { id, method, args }
// message and resolves the matching { id, result } reply.
//
// The worker is stateful on purpose: `open` keeps each database (and its
// unsaved edits) in memory across calls, exactly as db.js did in-process.
// `repo` rides along on every request rather than being queried from here —
// the worker has no access to main's repo module.

const PAGE_SIZE = 200; // rows fetched per page (offset paging in the renderer)

let SQL = null;          // the sql.js namespace, initialized once on first open
const open = new Map();  // absPath -> { db, dirty, meta: Map<table, tableMeta> }
let repoPath = null;     // set from the incoming message before dispatch

async function ensureSql() {
  if (SQL) return SQL;
  const initSqlJs = require('sql.js');
  const dir = path.dirname(require.resolve('sql.js'));
  SQL = await initSqlJs({ locateFile: (f) => path.join(dir, f) });
  return SQL;
}

function resolveInRepo(file) {
  if (!repoPath) return null;
  const abs = path.join(repoPath, file);
  const inside = path.relative(repoPath, abs);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return abs;
}

function closeAll() {
  for (const st of open.values()) { try { st.db.close(); } catch { /* already freed */ } }
  open.clear();
  return { ok: true };
}

// A BLOB comes back from sql.js as a Uint8Array; it can't be edited inline and
// shouldn't be shoved through IPC as raw bytes, so collapse it to a labeled
// placeholder the renderer renders read-only.
function cellOut(v) {
  if (v instanceof Uint8Array) return { __blob: v.length };
  return v; // number | string | null
}

// Tables/views in the database, tables first then views, user objects only.
function readSchema(st) {
  const res = st.db.exec(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type='view', name"
  );
  const items = [];
  if (res[0]) for (const [name, type] of res[0].values) items.push({ name, type });
  return items;
}

// Columns + the chosen row-identity for one table, cached per open database. A
// view (or a table with no usable identity) is flagged non-editable so the
// renderer shows it read-only instead of offering edits that can't target a row.
function tableMeta(st, table) {
  if (st.meta.has(table)) return st.meta.get(table);
  const info = st.db.exec(`PRAGMA table_info(${quoteIdent(table)})`);
  const columns = [];
  if (info[0]) for (const row of info[0].values) {
    // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
    columns.push({ name: row[1], type: row[2] || '', notnull: !!row[3], pk: !!row[5] });
  }
  let hasRowid = false;
  try { st.db.exec(`SELECT rowid FROM ${quoteIdent(table)} LIMIT 1`); hasRowid = true; }
  catch { hasRowid = false; } // WITHOUT ROWID table, or a view
  const typeRes = st.db.exec(`SELECT type FROM sqlite_master WHERE name = ${quoteLiteral(table)}`);
  const objType = typeRes[0] ? typeRes[0].values[0][0] : 'table';
  const identity = rowIdentity(columns, hasRowid);
  const editable = objType === 'table' && identity.kind !== 'all';
  const meta = { columns, identity, hasRowid, editable, objType };
  st.meta.set(table, meta);
  return meta;
}

function getState(file) {
  const abs = resolveInRepo(file);
  if (!abs) return { error: 'Invalid path' };
  const st = open.get(abs);
  if (!st) return { error: 'Database is not open' };
  return { abs, st };
}

// Open (or reuse) a database file. A file with unsaved edits is reused as-is; an
// unmodified one is re-read from disk so external changes show. Non-SQLite files
// never open — a recognized engine is reported so the renderer can explain it.
async function openDb(file) {
  const abs = resolveInRepo(file);
  if (!abs) return { ok: false, error: 'Invalid path' };
  const engine = engineForFile(file);

  let st = open.get(abs);
  if (st && !st.dirty) { try { st.db.close(); } catch { /* freed */ } open.delete(abs); st = null; }

  if (!st) {
    let bytes;
    try { bytes = fs.readFileSync(abs); }
    catch (e) { return { ok: false, error: e.message }; }
    if (!isSqliteBuffer(bytes)) {
      // Recognized non-SQLite engine → name it; otherwise a generic rejection.
      if (engine && !engine.editable) return { ok: false, editable: false, engine: { id: engine.id, label: engine.label } };
      return { ok: false, error: 'Not a SQLite database (unrecognized file header)' };
    }
    try {
      await ensureSql();
      st = { db: new SQL.Database(bytes), dirty: false, meta: new Map() };
      open.set(abs, st);
    } catch (e) { return { ok: false, error: e.message }; }
  }

  const label = engine ? engine.label : 'SQLite';
  return { ok: true, editable: true, engine: { id: engine ? engine.id : 'sqlite', label }, dirty: st.dirty, schema: readSchema(st) };
}

// One page of a table/view: column metadata, the rows (each with its rowid when
// available, for later edits), the total row count, and whether it's editable.
function loadTable(file, table, page = 0) {
  const { st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    const meta = tableMeta(st, table);
    const total = st.db.exec(buildCount(table))[0].values[0][0];
    const offset = Math.max(0, page | 0) * PAGE_SIZE;
    const res = st.db.exec(buildSelect(table, { limit: PAGE_SIZE, offset, withRowid: meta.hasRowid }));
    const rows = [];
    if (res[0]) for (const v of res[0].values) {
      const rowid = meta.hasRowid ? v[0] : null;
      const cells = (meta.hasRowid ? v.slice(1) : v).map(cellOut);
      rows.push({ rowid, cells });
    }
    return {
      ok: true, table, page, pageSize: PAGE_SIZE, total,
      columns: meta.columns, editable: meta.editable, objType: meta.objType,
      identity: meta.identity, rows,
    };
  } catch (e) { return { ok: false, error: e.message }; }
}

// WHERE-clause bind values for one row, from the identity kind chosen at load.
function identityParams(meta, rowid, originalRow) {
  if (meta.identity.kind === 'rowid') return [rowid];
  return meta.identity.cols.map((c) => (originalRow ? originalRow[c] : null));
}

function updateCell(file, table, rowid, originalRow, column, value) {
  const { st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    const meta = tableMeta(st, table);
    if (!meta.editable) return { ok: false, error: 'This object is read-only' };
    const col = meta.columns.find((c) => c.name === column);
    const coerced = coerceInput(value, col ? col.type : '');
    const sql = buildUpdate(table, column, meta.identity.cols, meta.identity.kind);
    st.db.run(sql, [coerced, ...identityParams(meta, rowid, originalRow)]);
    st.dirty = true;
    return { ok: true, value: coerced };
  } catch (e) { return { ok: false, error: e.message }; }
}

function insertRow(file, table, values) {
  const { st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    const meta = tableMeta(st, table);
    if (!meta.editable) return { ok: false, error: 'This object is read-only' };
    const cols = meta.columns.map((c) => c.name);
    const params = meta.columns.map((c) => coerceInput(values ? values[c.name] : null, c.type));
    st.db.run(buildInsert(table, cols), params);
    st.dirty = true;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function deleteRow(file, table, rowid, originalRow) {
  const { st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    const meta = tableMeta(st, table);
    if (!meta.editable) return { ok: false, error: 'This object is read-only' };
    st.db.run(buildDelete(table, meta.identity.cols, meta.identity.kind), identityParams(meta, rowid, originalRow));
    st.dirty = true;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Run arbitrary SQL from the console. A write query dirties the database and
// invalidates the cached table metadata (the schema may have changed); the last
// result set (if any) is returned for display.
function runQuery(file, sql) {
  const { st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    const res = st.db.exec(sql);
    const readonly = isReadOnlySql(sql);
    if (!readonly) { st.dirty = true; st.meta.clear(); }
    const results = res.map((r) => ({ columns: r.columns, rows: r.values.map((row) => row.map(cellOut)) }));
    return { ok: true, results, rowsModified: st.db.getRowsModified(), readonly, schema: readSchema(st) };
  } catch (e) { return { ok: false, error: e.message }; }
}

function saveDb(file) {
  const { abs, st, error } = getState(file);
  if (error) return { ok: false, error };
  try {
    fs.writeFileSync(abs, Buffer.from(st.db.export()));
    st.dirty = false;
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

const methods = {
  'db-open': ({ file }) => openDb(file),
  'db-table': ({ file, table, page }) => loadTable(file, table, page),
  'db-update-cell': ({ file, table, rowid, originalRow, column, value }) =>
    updateCell(file, table, rowid, originalRow, column, value),
  'db-insert-row': ({ file, table, values }) => insertRow(file, table, values),
  'db-delete-row': ({ file, table, rowid, originalRow }) => deleteRow(file, table, rowid, originalRow),
  'db-query': ({ file, sql }) => runQuery(file, sql),
  'db-save': ({ file }) => saveDb(file),
  'close-all': () => closeAll(),
};

parentPort.on('message', async ({ id, method, repo, args }) => {
  repoPath = repo || null;
  let result;
  try { result = await methods[method](args || {}); }
  catch (e) { result = { ok: false, error: e && e.message ? e.message : String(e) }; }
  parentPort.postMessage({ id, result });
});
