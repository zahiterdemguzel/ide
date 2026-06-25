const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
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
const sessions = new Map(); // id -> { pty, edits: Map<absPath, op[]>, firstPrompt }
let hookPort = 0;

// Turn one file-editing tool call into a replayable op, so we can later rebuild
// "HEAD + only this session's edits" for the file. An op is one of:
//   { t: 'write', content }                  full-content write (Write tool)
//   { t: 'edit',  old, new, all }            single string replacement (Edit)
//   { t: 'multi', edits: [{old,new,all}] }   ordered replacements (MultiEdit)
//   { t: 'opaque' }                          un-replayable (NotebookEdit) -> fall back
function editOp(toolName, ti) {
  if (toolName === 'Write') return { t: 'write', content: ti.content || '' };
  if (toolName === 'Edit') return { t: 'edit', old: ti.old_string ?? '', new: ti.new_string ?? '', all: !!ti.replace_all };
  if (toolName === 'MultiEdit') {
    return { t: 'multi', edits: (ti.edits || []).map((e) => ({ old: e.old_string ?? '', new: e.new_string ?? '', all: !!e.replace_all })) };
  }
  return { t: 'opaque' };
}

// Replay a session's ops onto a base string. Returns { content, clean } where
// clean=false means an edit's old_string wasn't found (the other session moved
// it, or an opaque op) — caller then falls back to the whole working file.
function replayEdits(base, ops) {
  let s = base, clean = true;
  for (const op of ops) {
    if (op.t === 'opaque') { clean = false; continue; }
    if (op.t === 'write') { s = op.content; continue; }
    for (const e of (op.t === 'multi' ? op.edits : [op])) {
      if (!e.old) { s += e.new; continue; } // insertion with empty old_string
      if (!s.includes(e.old)) { clean = false; continue; }
      s = e.all ? s.split(e.old).join(e.new)
        : s.slice(0, s.indexOf(e.old)) + e.new + s.slice(s.indexOf(e.old) + e.old.length);
    }
  }
  return { content: s, clean };
}

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
    generateSessionName(payload.session_id, s.firstPrompt);
    changed = true;
  }
  if (payload.hook_event_name === 'PostToolUse') {
    const ti = payload.tool_input || {};
    const f = ti.file_path;
    if (f && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(payload.tool_name)) {
      if (!s.edits.has(f)) s.edits.set(f, []);
      s.edits.get(f).push(editOp(payload.tool_name, ti));
      changed = true;
    }
  }
  return changed ? { id: payload.session_id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] } : null;
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

// Name a session from its first prompt via a one-shot Haiku call (`claude -p`),
// then push `session-name` to the renderer. Reuses the resolved claude CLI, so
// no API key or new dependency. Prompt goes over stdin to avoid arg-escaping.
function generateSessionName(id, prompt) {
  // ponytail: 2000-char cap is plenty for a title; bump if titles read truncated
  const text = 'Reply with ONLY a 2-4 word title (no quotes, no trailing punctuation) '
    + 'for this coding session:\n\n' + prompt.slice(0, 2000);
  const exe = resolveClaude();
  const win32 = process.platform === 'win32';
  const child = execFile(win32 ? `"${exe}"` : exe, ['-p', '--model', 'haiku'],
    { cwd: repoPath, maxBuffer: 1024 * 1024, shell: win32 },
    (err, stdout) => {
      if (err) return;
      const name = stdout.trim().split('\n').pop().trim().slice(0, 60);
      const s = sessions.get(id);
      if (name && s) { s.name = name; if (win) win.webContents.send('session-name', { id, name }); }
    });
  child.stdin.end(text);
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
// opts.env overrides env (e.g. GIT_INDEX_FILE for a throwaway index); opts.input
// is written to stdin (e.g. blob content for hash-object). 64M buffer for files.
function git(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd: repoPath, env: opts.env || process.env, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && err.message) || '' }));
    if (opts.input != null) child.stdin.end(opts.input);
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
// Undo last commit, keep its changes staged. ponytail: soft reset, no HEAD~1 history rewrite beyond one.
ipcMain.handle('git-undo', () => git(['reset', '--soft', 'HEAD~1']));
ipcMain.handle('git-push', () => git(['push']));

// List one directory level for the file explorer (lazy: children fetched on
// expand). Folders first, then alphabetical — VS Code order. `.git` is hidden.
ipcMain.handle('list-dir', (_e, rel) => {
  try {
    const dir = path.join(repoPath, rel || '');
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Read a repo-relative text file for the explorer's read-only viewer.
ipcMain.handle('read-text', (_e, file) => {
  try { return { ok: true, text: fs.readFileSync(path.join(repoPath, file), 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

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

// Build one commit whose tree is HEAD with only `entries` ({path, content})
// overwritten — via a throwaway index + commit-tree, so the real index and the
// working tree are never touched. That's what lets two sessions that edited the
// SAME file each commit only their own hunks: we commit a synthesized blob, not
// whatever the shared working file currently holds.
async function commitBlobs(entries, msg) {
  const head = await git(['rev-parse', '-q', '--verify', 'HEAD']);
  const headSha = head.stdout.trim();
  const idxFile = path.join(os.tmpdir(), `ide-sess-idx-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };
  const staged = []; // {path, sha} to also sync into the real index after the commit
  try {
    const seed = headSha ? await git(['read-tree', headSha], { env }) : await git(['read-tree', '--empty'], { env });
    if (!seed.ok) return seed;
    for (const e of entries) {
      const hash = await git(['hash-object', '-w', '--stdin', '--path', e.path], { input: e.content });
      if (!hash.ok) return hash;
      const sha = hash.stdout.trim();
      const upd = await git(['update-index', '--add', '--cacheinfo', `100644,${sha},${e.path}`], { env });
      if (!upd.ok) return upd;
      staged.push({ path: e.path, sha });
    }
    const tree = await git(['write-tree'], { env });
    if (!tree.ok) return tree;
    const ct = await git(['commit-tree', tree.stdout.trim(), '-m', msg, ...(headSha ? ['-p', headSha] : [])]);
    if (!ct.ok) return ct;
    const ref = await git(['update-ref', 'HEAD', ct.stdout.trim()]);
    if (!ref.ok) return ref;
    // Point the REAL index at the committed blobs for just these paths, so they
    // read as clean against the new HEAD and only the OTHER session's edits
    // remain as unstaged changes. Other paths in the index are left alone.
    for (const e of staged) await git(['update-index', '--cacheinfo', `100644,${e.sha},${e.path}`]);
    return ct;
  } finally {
    try { fs.unlinkSync(idxFile); } catch {}
  }
}

// Commit ONLY the hunks this session edited, using its first prompt as the
// message. For each touched file we replay the session's own edits onto the
// committed (HEAD) version and commit that — so another session's edits to the
// same file are left uncommitted in the working tree. If an edit can't be
// replayed cleanly (the other session moved that text, or an opaque op), we fall
// back to the whole current file for that path.
ipcMain.handle('commit-session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const entries = [];
  for (const [abs, ops] of s.edits) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    const headFile = await git(['show', `HEAD:${rel}`]);
    const { content, clean } = replayEdits(headFile.ok ? headFile.stdout : '', ops);
    if (clean) { entries.push({ path: rel, content }); continue; }
    try { entries.push({ path: rel, content: fs.readFileSync(abs, 'utf8') }); } catch { /* gone */ }
  }
  if (!entries.length) return { ok: false, stderr: 'This session changed no files yet' };
  const msg = (s.firstPrompt || `session ${id.slice(0, 8)}`).slice(0, 500);
  return commitBlobs(entries, msg);
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
  sessions.set(id, { pty: p, edits: new Map(), firstPrompt: '', name: '' });
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
