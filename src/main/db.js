const { ipcMain } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
const { getRepoPath, onRepoChange } = require('./repo');

// --- database viewer/editor (main side) ---
// Thin proxy: every call is forwarded to a worker thread (db-worker.js) that
// owns the sql.js state, so loading a multi-megabyte database or running a slow
// user query never blocks the main process — PTY output, git status, and every
// other IPC stay live while a query runs. The worker is spawned lazily on the
// first database call (startup never pays for it) and holds each open database
// (with unsaved edits) in its own memory across calls.

let worker = null;
let nextId = 1;
const pending = new Map(); // id -> resolve

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, 'db-worker.js'));
  worker.on('message', ({ id, result }) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  });
  // A dead worker (OOM on a huge database, a sql.js crash) must not strand the
  // renderer's awaits or kill the app — fail the in-flight calls and start a
  // fresh worker (with no open databases) on the next call.
  const fail = (why) => {
    for (const resolve of pending.values()) resolve({ ok: false, error: `Database worker ${why}` });
    pending.clear();
    worker = null;
  };
  worker.on('error', (err) => { console.error('[db worker]', err); fail('crashed'); });
  worker.on('exit', (code) => { if (code !== 0) fail(`exited (${code})`); });
  return worker;
}

function call(method, args) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ensureWorker().postMessage({ id, method, repo: getRepoPath(), args });
  });
}

ipcMain.handle('db-open', (_e, file) => call('db-open', { file }));
ipcMain.handle('db-table', (_e, { file, table, page }) => call('db-table', { file, table, page }));
ipcMain.handle('db-update-cell', (_e, { file, table, rowid, originalRow, column, value }) =>
  call('db-update-cell', { file, table, rowid, originalRow, column, value }));
ipcMain.handle('db-insert-row', (_e, { file, table, values }) => call('db-insert-row', { file, table, values }));
ipcMain.handle('db-delete-row', (_e, { file, table, rowid, originalRow }) =>
  call('db-delete-row', { file, table, rowid, originalRow }));
ipcMain.handle('db-query', (_e, { file, sql }) => call('db-query', { file, sql }));
ipcMain.handle('db-save', (_e, file) => call('db-save', { file }));

// Switching projects frees every cached database (and its in-memory copy of the
// file). Unsaved edits in the old repo are dropped — the same as closing a folder.
// Only bother if a worker exists — no databases were ever opened otherwise.
onRepoChange(() => { if (worker) call('close-all', {}); });

module.exports = {};
