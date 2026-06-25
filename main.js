const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { execFile, execFileSync } = require('child_process');
const crypto = require('crypto');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

let win;
// Restore the last opened folder; fall back to cwd on first run / bad path.
const lastFolderFile = path.join(app.getPath('userData'), 'last-folder.txt');
function loadLastFolder() {
  try {
    const p = fs.readFileSync(lastFolderFile, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.cwd();
}
let repoPath = loadLastFolder();
const sessions = new Map(); // id -> { pty, files: Set<absPath>, firstPrompt }
let hookPort = 0;

// Tools whose tool_input.file_path counts as a code change by the session.
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Extension → MIME for the asset viewer (image preview / pixel editor / audio).
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp',
  wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg',
};

// Attribute the user's first prompt and any edited files to their session, so
// we can later commit just that session's work. Returns updated meta, or null.
function recordSessionActivity(payload) {
  const s = sessions.get(payload.session_id);
  if (!s) return null;
  let changed = false;
  if (payload.hook_event_name === 'UserPromptSubmit' && !s.firstPrompt && payload.prompt) {
    s.firstPrompt = String(payload.prompt).trim();
    changed = true;
  }
  if (payload.hook_event_name === 'PostToolUse' && FILE_TOOLS.has(payload.tool_name)) {
    const f = payload.tool_input && payload.tool_input.file_path;
    if (f && !s.files.has(f)) { s.files.add(f); changed = true; }
  }
  return changed ? { id: payload.session_id, firstPrompt: s.firstPrompt || '', files: [...s.files] } : null;
}

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
        const meta = recordSessionActivity(payload);
        if (meta && win) win.webContents.send('session-meta', meta);
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
  try { fs.writeFileSync(lastFolderFile, repoPath); } catch {}
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

// Untracked files have nothing to diff against, so compare to /dev/null
// (git-for-windows accepts it); exit code 1 just means "they differ".
ipcMain.handle('git-diff', (_e, { file, staged, untracked }) => {
  if (untracked) return git(['diff', '--no-index', '--', '/dev/null', file]);
  return git(['diff', ...(staged ? ['--cached'] : []), '--', file]);
});

// Discard a file's changes: delete it if untracked, else restore index+worktree to HEAD.
ipcMain.handle('git-revert', (_e, { file, untracked }) => {
  if (untracked) return git(['clean', '-fq', '--', file]);
  return git(['restore', '--staged', '--worktree', '--', file]);
});

ipcMain.handle('git-commit', (_e, msg) => git(['commit', '-m', msg]));
ipcMain.handle('git-push', () => git(['push']));

// Read/write a repo-relative binary asset as base64 for the viewer/editor.
// Paths come from git porcelain (inside the repo), so no traversal guard.
ipcMain.handle('read-asset', (_e, file) => {
  try {
    const abs = path.join(repoPath, file);
    const ext = path.extname(abs).slice(1).toLowerCase();
    return { ok: true, base64: fs.readFileSync(abs).toString('base64'),
      mime: ASSET_MIME[ext] || 'application/octet-stream' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('write-asset', (_e, { file, base64 }) => {
  try { fs.writeFileSync(path.join(repoPath, file), Buffer.from(base64, 'base64')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Commit ONLY the files this session edited, using its first prompt as the
// message. add+commit are both path-scoped, so other sessions' work is untouched.
ipcMain.handle('commit-session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const files = [...s.files]
    .map((f) => path.relative(repoPath, f).split(path.sep).join('/'))
    .filter((f) => f && !f.startsWith('..')); // drop anything outside the repo
  if (!files.length) return { ok: false, stderr: 'This session changed no files yet' };
  const msg = (s.firstPrompt || `session ${id.slice(0, 8)}`).slice(0, 500);
  const add = await git(['add', '--', ...files]);
  if (!add.ok) return add;
  return git(['commit', '-m', msg, '--', ...files]);
});

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
  sessions.set(id, { pty: p, files: new Set(), firstPrompt: '' });
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
