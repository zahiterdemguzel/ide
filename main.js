const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

let win;
let repoPath = process.cwd();
const sessions = new Map(); // id -> { pty }
let hookPort = 0;

// node-pty on Windows doesn't search PATH — resolve the full claude.exe path once.
let claudeCmd = null;
function resolveClaude() {
  if (claudeCmd) return claudeCmd;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['claude'], { encoding: 'utf8' });
    claudeCmd = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'claude';
  } catch { claudeCmd = 'claude'; }
  return claudeCmd;
}

// --- hooks injected per session via `claude --settings <json>` ---
// Every event posts its raw stdin payload to our local server, which derives
// state from hook_event_name. Same command for all events keeps this trivial.
function hooksSettings() {
  const cmd = `curl -s -X POST http://127.0.0.1:${hookPort}/hook -d @-`;
  const entry = [{ matcher: '*', hooks: [{ type: 'command', command: cmd }] }];
  const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
    'PostToolUse', 'Notification', 'PermissionRequest', 'Stop'];
  const hooks = {};
  for (const e of events) hooks[e] = entry; // unknown events simply never fire
  return JSON.stringify({ hooks });
}

function eventToState(payload) {
  switch (payload.hook_event_name) {
    case 'Stop': return 'completed';
    case 'Notification':
    case 'PermissionRequest': return 'needs-input';
    case 'PostToolUse': {
      const c = payload.tool_input && payload.tool_input.command;
      if (c && /git\s+push/.test(c)) return 'pushed';
      return 'working';
    }
    case 'SessionStart':
    case 'UserPromptSubmit':
    case 'PreToolUse': return 'working';
    default: return null;
  }
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.end('ok');
      try {
        const payload = JSON.parse(body);
        const state = eventToState(payload);
        if (state && payload.session_id && win) {
          win.webContents.send('status', { id: payload.session_id, state });
        }
      } catch { /* ignore malformed */ }
    });
  });
  server.listen(0, '127.0.0.1', () => { hookPort = server.address().port; });
}

// --- git (plain porcelain, no dep) ---
function git(args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repoPath }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' });
    });
  });
}

async function gitStatus() {
  const r = await git(['status', '--porcelain=v1']);
  if (!r.ok) return { ok: false, error: r.stderr, staged: [], unstaged: [] };
  const staged = [], unstaged = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const x = line[0], y = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1]; // rename
    if (x !== ' ' && x !== '?') staged.push({ status: x, file });
    if (y !== ' ') unstaged.push({ status: y === '?' ? '?' : y, file });
  }
  return { ok: true, staged, unstaged, repo: repoPath };
}

// --- ipc ---
// Resolve the git repo root for a chosen dir so porcelain paths and add/reset
// line up no matter which subfolder the user picked. Falls back to the dir itself.
function repoRoot(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return out.trim() || dir;
  } catch { return dir; }
}

ipcMain.handle('open-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  repoPath = repoRoot(r.filePaths[0]);
  return { canceled: false, repo: repoPath };
});

ipcMain.handle('git-status', () => gitStatus());
ipcMain.handle('git-stage', (_e, file) => git(['add', '--', file]));
ipcMain.handle('git-unstage', async (_e, file) => {
  const r = await git(['reset', '-q', 'HEAD', '--', file]);
  // ponytail: initial commit has no HEAD; fall back to removing from index
  if (!r.ok) return git(['rm', '--cached', '--', file]);
  return r;
});

ipcMain.handle('git-commit', (_e, msg) => git(['commit', '-m', msg]));
ipcMain.handle('git-push', () => git(['push']));

ipcMain.handle('new-session', (_e, { cols, rows }) => {
  const id = crypto.randomUUID();
  const p = pty.spawn(resolveClaude(), ['--session-id', id, '--settings', hooksSettings()], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: repoPath,
    env: process.env,
  });
  p.onData((data) => win && win.webContents.send('pty-data', { id, data }));
  p.onExit(() => {
    sessions.delete(id);
    if (win) win.webContents.send('status', { id, state: 'completed' });
  });
  sessions.set(id, { pty: p });
  return { id, repo: repoPath };
});

ipcMain.on('pty-input', (_e, { id, data }) => {
  const s = sessions.get(id);
  if (s) s.pty.write(data);
});
ipcMain.on('pty-resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id);
  if (s) try { s.pty.resize(cols, rows); } catch { /* race on close */ }
});
ipcMain.on('kill-session', (_e, { id }) => {
  const s = sessions.get(id);
  if (s) { s.pty.kill(); sessions.delete(id); }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload requires native node-pty
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  startHookServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) try { s.pty.kill(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
