const { ipcRenderer } = require('electron');

// Database viewer/editor: open a SQLite-family file, page through a table, edit
// cells / insert / delete rows, run arbitrary SQL, and save the file back. The
// database lives in the main process (sql.js); these calls operate on it by the
// repo-relative file path.
module.exports = {
  dbOpen: (file) => ipcRenderer.invoke('db-open', file),
  dbTable: (file, table, page) => ipcRenderer.invoke('db-table', { file, table, page }),
  dbUpdateCell: (file, table, rowid, originalRow, column, value) =>
    ipcRenderer.invoke('db-update-cell', { file, table, rowid, originalRow, column, value }),
  dbInsertRow: (file, table, values) => ipcRenderer.invoke('db-insert-row', { file, table, values }),
  dbDeleteRow: (file, table, rowid, originalRow) =>
    ipcRenderer.invoke('db-delete-row', { file, table, rowid, originalRow }),
  dbQuery: (file, sql) => ipcRenderer.invoke('db-query', { file, sql }),
  dbSave: (file) => ipcRenderer.invoke('db-save', file),
};
