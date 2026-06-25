const { app, BrowserWindow, Menu } = require('electron');
const { createWindow } = require('./window');
const { startHookServer } = require('./hook-server');
const { killAllSessions } = require('./sessions');

// Requiring each subsystem registers its ipcMain handlers as a load side-effect.
require('./repo');
require('./git');
require('./sessions');
require('./session-commit');
require('./explorer');
require('./run-configs');
require('./consoles');

process.on('uncaughtException', (err) => console.error('[main uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[main unhandledRejection]', err));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no native File/Edit/View menu — the in-app run toolbar replaces it
  startHookServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  killAllSessions();
  if (process.platform !== 'darwin') app.quit();
});
