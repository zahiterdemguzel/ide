const { ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { getRepoPath } = require('./repo');
const { git } = require('./git');

// Extension → MIME for the asset viewer (image preview / pixel editor / audio).
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
  wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg',
};

// List one directory level for the file explorer (lazy: children fetched on
// expand). Folders first, then alphabetical — VS Code order. `.git` is hidden.
ipcMain.handle('list-dir', (_e, rel) => {
  try {
    const dir = path.join(getRepoPath(), rel || '');
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Create an empty file at a repo-relative path for the explorer's "New file"
// action. Parent folders are created as needed; refuses to clobber an existing
// file and guards against paths escaping the repo.
ipcMain.handle('create-file', (_e, rel) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, rel || '');
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, error: 'Invalid path' };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '', { flag: 'wx' }); // wx: fail if it already exists
    return { ok: true, rel: inside.split(path.sep).join('/') };
  } catch (e) {
    return { ok: false, error: e.code === 'EEXIST' ? 'A file with that name already exists' : e.message };
  }
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
  const repoPath = getRepoPath();
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
  try { return { ok: true, text: fs.readFileSync(path.join(getRepoPath(), file), 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Write a repo-relative text file from the in-app editor.
ipcMain.handle('write-text', (_e, { file, text }) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, file);
    const rel = path.relative(repoPath, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: 'Invalid path' };
    }
    fs.writeFileSync(abs, text, 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Resolve a path the user Ctrl+clicked in the terminal. Absolute paths are used
// as-is; bare ones resolve against the session cwd (= repoPath). Reports whether
// it exists, is a file, and sits inside the repo — the renderer routes in-repo
// files to the explorer's viewer and anything else to the OS via open-external.
ipcMain.handle('resolve-link-path', (_e, raw) => {
  try {
    const p = String(raw || '').trim();
    if (!p) return { ok: false };
    const repoPath = getRepoPath();
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
    const abs = path.join(getRepoPath(), file);
    const ext = path.extname(abs).slice(1).toLowerCase();
    return { ok: true, base64: fs.readFileSync(abs).toString('base64'),
      mime: ASSET_MIME[ext] || 'application/octet-stream' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('write-asset', (_e, { file, base64 }) => {
  try { fs.writeFileSync(path.join(getRepoPath(), file), Buffer.from(base64, 'base64')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

module.exports = {};
