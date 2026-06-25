const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
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

// De-apply a session's ops from the current working string (the inverse of
// replayEdits) — back out just this session's substitutions, leaving any other
// session's edits to the same file untouched. Ops are inverted newest-first:
// for an Edit, new->old. Returns { content, clean }; clean=false means an op
// can't be safely inverted (a full Write or opaque op has no stored pre-image,
// a pure deletion can't be relocated, or the new_string is gone) — caller then
// decides whether a hard reset to HEAD is safe.
function inverseEdits(working, ops) {
  let s = working, clean = true;
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.t === 'write' || op.t === 'opaque') { clean = false; continue; }
    const edits = op.t === 'multi' ? op.edits : [op];
    for (let j = edits.length - 1; j >= 0; j--) {
      const e = edits[j];
      if (!e.new) { clean = false; continue; } // pure deletion: can't relocate the old text
      if (!s.includes(e.new)) { clean = false; continue; }
      s = e.all ? s.split(e.new).join(e.old)
        : s.slice(0, s.indexOf(e.new)) + e.old + s.slice(s.indexOf(e.new) + e.new.length);
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

// --- VS Code run configs (.vscode/launch.json + tasks.json) ---
// We don't run a real debugger; each launch config / task is translated into a
// shell command and opened in a NEW external terminal window (see openTerminal).

// Parse JSONC (VS Code config files allow // and /* */ comments and trailing
// commas). Strip comments outside of strings, drop trailing commas, JSON.parse.
function parseJsonc(text) {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], c2 = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += c2 ?? ''; i++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && c2 === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readVscodeJson(name) {
  try { return parseJsonc(fs.readFileSync(path.join(repoPath, '.vscode', name), 'utf8')); }
  catch { return null; }
}

// Resolve the VS Code variables we can without a live editor context. Unknown
// ${...} placeholders (e.g. ${file}) are left untouched — best effort.
function substVars(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/\$\{workspaceFolder(?:Basename)?\}/g, (m) => m.includes('Basename') ? path.basename(repoPath) : repoPath)
    .replace(/\$\{workspaceRoot\}/g, repoPath)
    .replace(/\$\{cwd\}/g, repoPath)
    .replace(/\$\{pathSeparator\}/g, path.sep)
    .replace(/\$\{env:([^}]+)\}/g, (_, n) => process.env[n] || '');
}

const quoteArg = (a) => { a = String(a); return /\s/.test(a) ? `"${a}"` : a; };
function envMap(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) out[k] = substVars(String(v));
  return out;
}

// Turn a launch config into a runnable command line. Covers the common node /
// python cases plus a generic runtimeExecutable/program fallback; returns null
// when there's nothing executable to derive.
function buildLaunchCommand(cfg) {
  const program = cfg.program ? substVars(cfg.program) : '';
  const args = (cfg.args || []).map(substVars);
  const runExe = cfg.runtimeExecutable ? substVars(cfg.runtimeExecutable) : '';
  const runArgs = (cfg.runtimeArgs || []).map(substVars);
  const type = (cfg.type || '').toLowerCase();
  let parts;
  if (type.includes('node')) parts = [runExe || 'node', ...runArgs, program, ...args];
  else if (type.includes('python') || type === 'debugpy') parts = [runExe || 'python', ...runArgs, program, ...args];
  else if (runExe) parts = [runExe, ...runArgs, program, ...args];
  else if (program) parts = [program, ...args];
  else return null;
  return parts.filter((p) => p !== '' && p != null).map(quoteArg).join(' ');
}

// Turn a task into a command line: `command` (verbatim for shell tasks, which may
// be a full line) followed by its quoted args. Returns null with no command.
function buildTaskCommand(task) {
  let command = task.command;
  if (command && typeof command === 'object') command = command.value;
  command = substVars(command || '');
  if (!command) return null;
  const args = (task.args || []).map((a) => substVars(typeof a === 'object' ? (a.value ?? '') : a));
  if (task.type === 'process') return [command, ...args].map(quoteArg).join(' ');
  return [command, ...args.map(quoteArg)].join(' '); // shell task: command stays verbatim
}

// A run spec the renderer turns into an in-app terminal tab: the command line plus
// the cwd/env to spawn its shell in, and the name used as the tab label.
function launchSpec(cfg) {
  const cmd = buildLaunchCommand(cfg);
  if (!cmd) return null;
  return { command: cmd, cwd: cfg.cwd ? substVars(cfg.cwd) : repoPath, env: envMap(cfg.env), name: cfg.name };
}

// Names for the toolbar: launch configs + compounds, then task labels.
ipcMain.handle('get-run-configs', () => {
  const launch = readVscodeJson('launch.json');
  const tasks = readVscodeJson('tasks.json');
  const launchList = [];
  if (launch) {
    for (const c of (launch.configurations || [])) if (c && c.name) launchList.push({ name: c.name });
    for (const c of (launch.compounds || [])) if (c && c.name) launchList.push({ name: c.name, compound: true });
  }
  const taskList = [];
  if (tasks) for (const t of (tasks.tasks || [])) { const n = t && (t.label || t.taskName); if (n) taskList.push({ name: n }); }
  return { launch: launchList, tasks: taskList };
});

// Resolve one config/task by name into run specs (re-reads the files so edits are
// always picked up). The renderer opens an in-app terminal per spec; a compound
// yields one spec per referenced configuration.
ipcMain.handle('run-config', (_e, { kind, name }) => {
  if (kind === 'task') {
    const tasks = readVscodeJson('tasks.json');
    const t = (tasks && tasks.tasks || []).find((x) => (x.label || x.taskName) === name);
    if (!t) return { ok: false, error: 'Task not found' };
    const cmd = buildTaskCommand(t);
    if (!cmd) return { ok: false, error: 'Task has no command' };
    const opt = t.options || {};
    return { ok: true, runs: [{ command: cmd, cwd: opt.cwd ? substVars(opt.cwd) : repoPath, env: envMap(opt.env), name }] };
  }
  const launch = readVscodeJson('launch.json');
  if (!launch) return { ok: false, error: 'No launch.json' };
  const compound = (launch.compounds || []).find((c) => c.name === name);
  if (compound) {
    const runs = [];
    for (const ref of (compound.configurations || [])) {
      const refName = typeof ref === 'object' ? ref.name : ref;
      const cfg = (launch.configurations || []).find((c) => c.name === refName);
      if (cfg) { const s = launchSpec(cfg); if (s) runs.push(s); }
    }
    return runs.length ? { ok: true, runs } : { ok: false, error: 'Compound references no runnable configs' };
  }
  const cfg = (launch.configurations || []).find((c) => c.name === name);
  if (!cfg) return { ok: false, error: 'Config not found' };
  const s = launchSpec(cfg);
  return s ? { ok: true, runs: [s] } : { ok: false, error: 'Could not derive a run command for this config' };
});

// --- git (plain porcelain, no dep) ---
// opts.env overrides env (e.g. GIT_INDEX_FILE for a throwaway index); opts.input
// is written to stdin (e.g. blob content for hash-object). 64M buffer for files.
function git(args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile('git', args, { cwd: repoPath, env: opts.env || process.env, maxBuffer: 64 * 1024 * 1024 },
      // git often reports failures on stdout (e.g. "nothing to commit"), so fall
      // back to stdout before err.message — otherwise the UI shows a bare "Command failed".
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err && (stdout.trim() || err.message)) || '' }));
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
  try {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    repoPath = repoRoot(r.filePaths[0]);
    try { fs.writeFileSync(lastFolderFile, repoPath); } catch {}
    return { canceled: false, repo: repoPath };
  } catch (err) {
    console.error('[open-folder failed]', err);
    return { canceled: true, error: String(err) };
  }
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

// Commit staged changes. If nothing is staged, stage everything first so a bare
// Commit click behaves like "commit all" rather than failing with "nothing to commit".
ipcMain.handle('git-commit', async (_e, msg) => {
  const nothingStaged = (await git(['diff', '--cached', '--quiet'])).ok;
  if (nothingStaged) await git(['add', '-A']);
  return git(['commit', '-m', msg]);
});
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

// Recursive filename search for the explorer. Walks the tree async, skipping
// .git/node_modules; case-insensitive, capped at 500 hits. A query of "*.png" or
// ".png" matches by extension; any other query is a substring of the filename
// (which includes the extension, so a bare "png" / "js" gathers that type too).
const SEARCH_SKIP = new Set(['.git', 'node_modules']);
ipcMain.handle('search-names', async (_e, q) => {
  const needle = (q || '').trim().toLowerCase();
  if (!needle) return { ok: true, files: [] };
  const ext = /^\*?\.([a-z0-9]+)$/.exec(needle);
  const suffix = ext ? '.' + ext[1] : null;
  const files = [];
  async function walk(rel) {
    if (files.length >= 500) return;
    let ents;
    try { ents = await fs.promises.readdir(path.join(repoPath, rel), { withFileTypes: true }); }
    catch { return; }
    for (const d of ents) {
      if (SEARCH_SKIP.has(d.name)) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { await walk(childRel); continue; }
      const name = d.name.toLowerCase();
      const hit = suffix ? name.endsWith(suffix) : name.includes(needle);
      if (hit && files.length < 500) files.push(childRel);
    }
  }
  await walk('');
  return { ok: true, files };
});

// Content search ("References"): git grep runs in a subprocess so it never
// blocks the main thread. --untracked also greps new (un-ignored) files; capped
// at 500 matches. ponytail: parse stdout regardless of exit code — grep exits 1
// on no matches (and when repoPath isn't a git repo, yielding empty results).
ipcMain.handle('search-refs', async (_e, q) => {
  if (!q) return { ok: true, matches: [] };
  const r = await git(['grep', '-n', '-I', '-F', '-i', '--untracked', '--', q]);
  const matches = [];
  for (const line of r.stdout.split('\n')) {
    if (!line || matches.length >= 500) break;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].slice(0, 200) });
  }
  return { ok: true, matches };
});

// Read a repo-relative text file for the explorer's read-only viewer.
ipcMain.handle('read-text', (_e, file) => {
  try { return { ok: true, text: fs.readFileSync(path.join(repoPath, file), 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Resolve a path the user Ctrl+clicked in the terminal. Absolute paths are used
// as-is; bare ones resolve against the session cwd (= repoPath). Reports whether
// it exists, is a file, and sits inside the repo — the renderer routes in-repo
// files to the explorer's viewer and anything else to the OS via open-external.
ipcMain.handle('resolve-link-path', (_e, raw) => {
  try {
    const p = String(raw || '').trim();
    if (!p) return { ok: false };
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(repoPath, p);
    const st = fs.statSync(abs); // throws if it doesn't exist
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    const inRepo = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    return { ok: true, isFile: st.isFile(), isDir: st.isDirectory(), inRepo, rel, abs };
  } catch { return { ok: false }; }
});

// Open a web URL in the default browser, or a filesystem path in its OS handler
// (used for the inline browser's "open externally" button and out-of-repo files).
ipcMain.handle('open-external', async (_e, target) => {
  try {
    if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return { ok: true }; }
    const err = await shell.openPath(target);
    return { ok: !err, error: err };
  } catch (e) { return { ok: false, error: e.message }; }
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
  const committedPaths = []; // absolute paths to forget from s.edits on success
  for (const [abs, ops] of s.edits) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    const headFile = await git(['show', `HEAD:${rel}`]);
    const { content, clean } = replayEdits(headFile.ok ? headFile.stdout : '', ops);
    if (clean) { entries.push({ path: rel, content }); committedPaths.push(abs); continue; }
    try { entries.push({ path: rel, content: fs.readFileSync(abs, 'utf8') }); committedPaths.push(abs); } catch { /* gone */ }
  }
  if (!entries.length) return { ok: false, stderr: 'This session changed no files yet' };
  const msg = (s.firstPrompt || `session ${id.slice(0, 8)}`).slice(0, 500);
  const r = await commitBlobs(entries, msg);
  if (r.ok) {
    // Forget the committed edits so this session now reads as having nothing to
    // commit, and tell the renderer so its commit button updates.
    for (const abs of committedPaths) s.edits.delete(abs);
    if (win) win.webContents.send('session-meta', { id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] });
  }
  return r;
});

// Revert ONLY this session's working-tree changes by de-applying its own edits,
// so another session's edits to the same file survive. For each touched file we
// back its ops out of the current working contents (inverseEdits). If an op
// can't be inverted (a full Write, opaque, or moved text), a hard reset to HEAD
// is only safe when NO other live session also edited that file — otherwise we
// skip it (clobbering another agent's work is worse than leaving ours). Reverted
// files are forgotten so a later commit/revert won't double-apply them.
ipcMain.handle('revert-session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const sharedWithOther = (abs) => [...sessions].some(([sid, o]) => sid !== id && o.edits.has(abs));
  const reverted = [], skipped = [];
  for (const [abs, ops] of s.edits) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    let working = null;
    try { working = fs.readFileSync(abs, 'utf8'); } catch { /* deleted */ }
    const inv = working == null ? { clean: false } : inverseEdits(working, ops);
    if (inv.clean) { fs.writeFileSync(abs, inv.content); reverted.push(abs); continue; }
    if (sharedWithOther(abs)) { skipped.push(rel); continue; }
    const head = await git(['show', `HEAD:${rel}`]);
    if (head.ok) fs.writeFileSync(abs, head.stdout); // restore committed version
    else { try { fs.unlinkSync(abs); } catch {} } // file was new this session
    reverted.push(abs);
  }
  for (const abs of reverted) s.edits.delete(abs); // forget only what we backed out; skips stay tracked
  if (win) win.webContents.send('session-meta', { id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] });
  if (!reverted.length && !skipped.length) return { ok: false, stderr: 'This session changed no files' };
  return { ok: true, reverted: reverted.length, skipped };
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

// --- git-pane consoles: interactive shell PTYs in the repo dir, keyed by id.
// The renderer shows one tab per terminal. A terminal may run a launch config /
// task command, which is written into the freshly-spawned shell.
const consoles = new Map(); // id -> pty

// Shells the user can pick from the + menu. The `name` becomes the tab label.
function availableShells() {
  if (process.platform === 'win32') {
    return [
      { name: 'ps', path: 'powershell.exe' },
      { name: 'cmd', path: process.env.COMSPEC || 'cmd.exe' },
    ];
  }
  const sh = process.env.SHELL || '/bin/bash';
  return [{ name: path.basename(sh).replace(/\.exe$/i, ''), path: sh }];
}

// Spawn a shell PTY under `id` (reused across restarts so term-data keeps routing
// to the same tab). The onExit guard ignores a pty we've already replaced, so a
// restart doesn't tear down its successor or report the tab as closed.
function spawnConsole(id, { cols, rows, shell, command, cwd, env } = {}) {
  const shPath = shell || availableShells()[0].path;
  const p = pty.spawn(shPath, [], {
    name: 'xterm-color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: cwd || repoPath,
    env: env ? { ...process.env, ...env } : process.env,
  });
  p.onData((data) => win && win.webContents.send('term-data', { id, data }));
  p.onExit(() => {
    if (consoles.get(id) !== p) return; // replaced by a restart — stay quiet
    consoles.delete(id);
    if (win) win.webContents.send('term-exit', { id });
  });
  consoles.set(id, p);
  if (command) p.write(command + '\r');
  return p;
}

ipcMain.handle('term-shells', () => availableShells());
ipcMain.handle('term-create', (_e, opts = {}) => {
  const id = crypto.randomUUID();
  spawnConsole(id, opts);
  return { id };
});
// Relaunch a config into an existing tab: kill the old pty (its onExit is silenced
// by the guard above once we've removed it) and spawn a fresh one under the same id.
ipcMain.handle('term-restart', (_e, opts = {}) => {
  const old = consoles.get(opts.id);
  if (old) { consoles.delete(opts.id); try { old.kill(); } catch { /* already gone */ } }
  spawnConsole(opts.id, opts);
  return { ok: true };
});
ipcMain.on('term-input', (_e, { id, data }) => { const p = consoles.get(id); if (p) p.write(data); });
ipcMain.on('term-resize', (_e, { id, cols, rows }) => {
  const p = consoles.get(id);
  if (p) try { p.resize(cols, rows); } catch { /* race on close */ }
});
ipcMain.on('term-kill', (_e, { id }) => {
  const p = consoles.get(id);
  if (p) { consoles.delete(id); try { p.kill(); } catch { /* already gone */ } }
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
      webviewTag: true, // inline web browser for Ctrl+clicked links
    },
  });
  win.loadFile('index.html');

  // Surface renderer-side problems in the `npm start` terminal — by default
  // console output and uncaught errors only show in DevTools, so a silently
  // broken button (e.g. a thrown click handler) leaves no trace otherwise.
  const levels = ['log', 'info', 'warning', 'error']; // chromium console levels
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${levels[level] || level}] ${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode);
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('[preload error]', preloadPath, error);
  });
}

process.on('uncaughtException', (err) => console.error('[main uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[main unhandledRejection]', err));

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // no native File/Edit/View menu — the in-app run toolbar replaces it
  startHookServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  for (const s of sessions.values()) try { s.pty.kill(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
