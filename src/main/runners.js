const { ipcMain, dialog, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { sharedDataDir } = require('./instance');
const { getRepoPath } = require('./repo');
const { LANGUAGES, langForFile, langById, buildRunCommand } = require('./runners-lib');

// --- run a single source file ---
// The editor's Run button resolves the open file's language (runners-lib), finds
// an interpreter for it (a user-registered path, else a binary on PATH), and
// returns a run spec the renderer opens in a terminal tab — the same shape the
// .vscode run toolbar uses. The pure translation lives in runners-lib.js; this
// module owns PATH probing, the registered-interpreter store, and IPC.

// Registered interpreter paths (langId -> absolute exe path) live in the shared
// data dir so they're machine-wide and survive restarts, like last-folder.txt.
const STORE_PATH = path.join(sharedDataDir, 'interpreters.json');

function loadInterpreters() {
  try { return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function saveInterpreters(map) {
  try {
    fs.mkdirSync(sharedDataDir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(map, null, 2));
  } catch (e) { console.error('[runners] save failed:', e); }
}

// Look up an executable on PATH without running anything. On Windows, honour
// PATHEXT so a bare `python` matches `python.exe`/`.cmd`/`.bat`. A name that
// already carries a path separator is checked as-is. Returns true if found.
function existsOnPath(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\')) return fileExists(bin);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) if (fileExists(path.join(dir, bin + ext))) return true;
  }
  return false;
}
function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Resolve the interpreter to run `lang` with: a registered path if it still
// exists, otherwise the first candidate binary present on PATH. Returns the
// command-line token to invoke (registered absolute path, or the bare PATH
// name), or null when nothing is available.
function resolveBinary(lang) {
  const saved = loadInterpreters()[lang.id];
  if (saved && fileExists(saved)) return saved;
  for (const cand of lang.bins) if (existsOnPath(cand)) return cand;
  return null;
}

// The languages the renderer can run, plus each one's registered interpreter (if
// any), so it knows which extensions show the Run button and what to display.
ipcMain.handle('get-runner-langs', () => {
  const saved = loadInterpreters();
  return {
    langs: LANGUAGES.map((l) => ({ id: l.id, name: l.name, exts: l.exts, interpreter: saved[l.id] || null })),
  };
});

// Resolve the open file into a run spec, or report why it can't run.
ipcMain.handle('resolve-runner', (_e, { file, args } = {}) => {
  const lang = langForFile(file);
  if (!lang) return { ok: false, unsupported: true };
  const bin = resolveBinary(lang);
  if (!bin) return { ok: false, needsInterpreter: true, lang: { id: lang.id, name: lang.name }, bins: lang.bins };
  const command = buildRunCommand(lang, bin, file, args || '');
  return {
    ok: true,
    lang: { id: lang.id, name: lang.name },
    run: { command, cwd: getRepoPath(), name: path.basename(file), kind: 'run' },
  };
});

// Let the user register the interpreter executable for a language (the "we
// couldn't find the binaries" recovery path). Persists the choice.
ipcMain.handle('pick-interpreter', async (_e, { langId } = {}) => {
  const lang = langById(langId);
  if (!lang) return { ok: false };
  const win = BrowserWindow.getFocusedWindow();
  const filters = process.platform === 'win32'
    ? [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat', 'com'] }, { name: 'All files', extensions: ['*'] }]
    : [{ name: 'All files', extensions: ['*'] }];
  const res = await dialog.showOpenDialog(win, {
    title: `Select the ${lang.name} interpreter`,
    properties: ['openFile'],
    filters,
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  const chosen = res.filePaths[0];
  const map = loadInterpreters();
  map[langId] = chosen;
  saveInterpreters(map);
  return { ok: true, path: chosen };
});

// Forget a registered interpreter so the language falls back to PATH detection.
ipcMain.handle('clear-interpreter', (_e, { langId } = {}) => {
  const map = loadInterpreters();
  delete map[langId];
  saveInterpreters(map);
  return { ok: true };
});

module.exports = {};
