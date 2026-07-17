const { shell, clipboard, session } = require('electron');
const bridge = require('./remote-bridge');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');
const { getRepoPath, onRepoChange } = require('./repo');
const { git } = require('./git');
const { shouldSkipDir, GREP_EXCLUDE_PATHSPECS } = require('./search-ignore');
const { sendToRenderer } = require('./window');
const { withClipboardRetry } = require('./clipboard-lib');

// Extension â†’ MIME for the asset viewer (image preview / pixel editor / audio /
// 3D model). The model MIMEs are only used to label the bytes; the three.js
// loaders dispatch off the extension, not the MIME.
const ASSET_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  // Video is absent on purpose: the player streams from the file:// URL that
  // 'file-url' hands back rather than reading the bytes through here.
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', fbx: 'application/octet-stream',
  obj: 'text/plain', usdz: 'model/vnd.usdz+zip', stl: 'model/stl', ply: 'application/octet-stream',
  ai: 'application/illustrator',
  pdf: 'application/pdf',
  apk: 'application/vnd.android.package-archive',
};

// List one directory level for the file explorer (lazy: children fetched on
// expand). Folders first, then alphabetical — VS Code order. `.git` is hidden.
bridge.handle('list-dir', async (_e, rel) => {
  try {
    const dir = path.join(getRepoPath(), rel || '');
    const entries = (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return { ok: true, entries };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Create an empty file at a repo-relative path for the explorer's "New file"
// action. Parent folders are created as needed; refuses to clobber an existing
// file and guards against paths escaping the repo.
bridge.handle('create-file', (_e, rel) => {
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

// Create an empty folder at a repo-relative path for the explorer's "New folder"
// action. Refuses to clobber an existing entry and guards against paths escaping
// the repo.
bridge.handle('create-folder', (_e, rel) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, rel || '');
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
      return { ok: false, error: 'Invalid path' };
    }
    if (fs.existsSync(abs)) {
      return { ok: false, error: 'An item with that name already exists' };
    }
    fs.mkdirSync(abs, { recursive: true });
    return { ok: true, rel: inside.split(path.sep).join('/') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Recursive filename search for the explorer. Walks the tree async, skipping
// dependency/build dirs (see search-ignore.js); case-insensitive, capped at 500
// hits. The query is split on whitespace into terms that ALL must match the
// file's full repo-relative path (e.g. "enemy .mp3" finds files whose path
// contains both "enemy" and ".mp3", so folder names count too). A term of
// "*.png" or ".png" matches by extension; any other term is a substring of the
// path (which includes the extension, so a bare "png" / "js" gathers that type too).
// fold() here mirrors the renderer's text-fold: NFC so a query typed precomposed
// ("ÅŸ") matches a filename the OS hands back decomposed ("s"+combining cedilla,
// as macOS volumes do), and lowercase for case-insensitivity. Indices don't
// matter for substring matching, so the simple whole-string form is enough.
const fold = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase();
bridge.handle('search-names', async (_e, q) => {
  const needle = fold((q || '').trim());
  if (!needle) return { ok: true, files: [] };
  const terms = needle.split(/\s+/).map((t) => {
    const ext = /^\*?\.([a-z0-9]+)$/.exec(t);
    return ext ? { suffix: '.' + ext[1] } : { sub: t };
  });
  const files = [];
  const repoPath = getRepoPath();
  async function walk(rel) {
    if (files.length >= 500) return;
    let ents;
    try { ents = await fs.promises.readdir(path.join(repoPath, rel), { withFileTypes: true }); }
    catch { return; }
    for (const d of ents) {
      if (d.isDirectory() && shouldSkipDir(d.name)) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { await walk(childRel); continue; }
      const hay = fold(childRel);
      const hit = terms.every((t) => (t.suffix ? hay.endsWith(t.suffix) : hay.includes(t.sub)));
      if (hit && files.length < 500) files.push(childRel);
    }
  }
  await walk('');
  return { ok: true, files };
});

// Flat list of every file in the repo for the Quick Open palette (Ctrl/Cmd+P),
// which fuzzy-matches client-side. Same async walk + skip dirs as search-names,
// but unfiltered and capped higher (10k) so big repos still open instantly.
bridge.handle('list-files', async () => {
  const files = [];
  const repoPath = getRepoPath();
  async function walk(rel) {
    if (files.length >= 10000) return;
    let ents;
    try { ents = await fs.promises.readdir(path.join(repoPath, rel), { withFileTypes: true }); }
    catch { return; }
    for (const d of ents) {
      if (d.isDirectory() && shouldSkipDir(d.name)) continue;
      const childRel = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) { await walk(childRel); continue; }
      if (files.length < 10000) files.push(childRel);
    }
  }
  await walk('');
  return { ok: true, files };
});

// Content search ("References"): git grep runs in a subprocess so it never
// blocks the main thread. --untracked also greps new (un-ignored) files; the
// trailing pathspecs prune dependency/build dirs (search-ignore.js) so an
// un-ignored node_modules doesn't drown out real hits. Capped at 500 matches.
// ponytail: parse stdout regardless of exit code — grep exits 1 on no matches
// (and when repoPath isn't a git repo, yielding empty results).
bridge.handle('search-refs', async (_e, q) => {
  if (!q) return { ok: true, matches: [] };
  const r = await git(['grep', '-n', '-I', '-F', '-i', '--untracked', '--', q, ...GREP_EXCLUDE_PATHSPECS]);
  const matches = [];
  for (const line of r.stdout.split('\n')) {
    if (!line || matches.length >= 500) break;
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].slice(0, 200) });
  }
  return { ok: true, matches };
});

// Read a repo-relative text file for the explorer's file editor.
bridge.handle('read-text', async (_e, file) => {
  try { return { ok: true, text: await fs.promises.readFile(path.join(getRepoPath(), file), 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Write a repo-relative text file back to disk (the editor's Save). Guards
// against paths escaping the repo, same as create/rename/delete.
bridge.handle('write-text', async (_e, { file, text }) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, file);
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Invalid path' };
    await fs.promises.writeFile(abs, text);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Resolve a path the user Ctrl+clicked in the terminal. Absolute paths are used
// as-is; bare ones resolve against `baseDir` — the *originating* terminal's own
// directory (a session's repo, or a console's cwd), which the renderer passes
// per-terminal since it can differ from whichever folder is currently open in
// the explorer. Falls back to the open folder when no baseDir is given (e.g.
// the onboarding terminal, before any repo is open). Reports whether the
// resolved path exists, is a file or dir, and sits inside the *open* repo —
// the renderer routes in-repo files to the explorer's viewer, directories to
// the OS file browser, and anything else to the OS via open-external.
const statOrNull = (p) => fs.promises.stat(p).then((st) => st, () => null);

// Last-resort lookup for a clicked relative path that resolves nowhere: walk
// the open repo (bounded, skipping heavy dirs) for a path whose tail matches.
// Handles tool output that prints paths relative to some deeper directory.
async function findInRepo(repoPath, relParts) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build']);
  const suffix = relParts.join('/').toLowerCase();
  const queue = [repoPath];
  let visited = 0;
  while (queue.length && visited < 400) {
    const dir = queue.shift();
    visited++;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!SKIP.has(ent.name)) queue.push(abs); continue; }
      const rel = path.relative(repoPath, abs).split(path.sep).join('/').toLowerCase();
      if (rel === suffix || rel.endsWith('/' + suffix)) return abs;
    }
  }
  return null;
}

bridge.handle('resolve-link-path', async (_e, raw, baseDir) => {
  try {
    const p = String(raw || '').trim();
    if (!p) return { ok: false };
    const repoPath = getRepoPath();
    const base = baseDir || repoPath;
    let abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(base, p);
    let st = await statOrNull(abs);
    if (!st && !path.isAbsolute(p)) {
      // Fallbacks for relative paths: the open repo root, then a bounded
      // repo-wide search treating the clicked text as a path suffix.
      const atRoot = path.resolve(repoPath, p);
      if (atRoot !== abs) { st = await statOrNull(atRoot); if (st) abs = atRoot; }
      if (!st) {
        const found = await findInRepo(repoPath, p.split(/[\\/]/).filter((s) => s && s !== '.' && s !== '..'));
        if (found) { abs = found; st = await statOrNull(found); }
      }
    }
    if (!st) return { ok: false };
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    const inRepo = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    return { ok: true, isFile: st.isFile(), isDir: st.isDirectory(), inRepo, rel, abs };
  } catch { return { ok: false }; }
});

// Open a web URL in the default browser, or a filesystem path in its OS handler
// (used for the inline browser's "open externally" button and out-of-repo files).
bridge.handle('open-external', async (_e, target) => {
  try {
    if (/^https?:\/\//i.test(target)) { await shell.openExternal(target); return { ok: true }; }
    const err = await shell.openPath(target);
    return { ok: !err, error: err };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Resolve a repo-relative path to a file:// URL for the editor's HTML preview
// webview. pathToFileURL handles the drive letter and percent-encodes spaces and
// non-ASCII characters, so the webview loads it verbatim. Guarded to stay in-repo.
bridge.handle('file-url', (_e, file) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, file);
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Invalid path' };
    return { ok: true, url: pathToFileURL(abs).href };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Clear the inline browser's cookies. The <webview> runs in the persistent
// `persist:browser` partition (so cookies survive restarts); this wipes just
// that partition's cookies, leaving the app's own session untouched.
bridge.handle('clear-web-data', async () => {
  try {
    await session.fromPartition('persist:browser').clearStorageData({ storages: ['cookies'] });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Rename a file or folder within the repo.
bridge.handle('rename-file', (_e, oldRel, newRel) => {
  try {
    const repoPath = getRepoPath();
    const oldAbs = path.join(repoPath, oldRel);
    const newAbs = path.join(repoPath, newRel);
    const oldInside = path.relative(repoPath, oldAbs);
    const newInside = path.relative(repoPath, newAbs);
    if (!oldInside || oldInside.startsWith('..') || path.isAbsolute(oldInside)) return { ok: false, error: 'Invalid path' };
    if (!newInside || newInside.startsWith('..') || path.isAbsolute(newInside)) return { ok: false, error: 'Invalid path' };
    if (fs.existsSync(newAbs)) return { ok: false, error: 'A file with that name already exists' };
    fs.renameSync(oldAbs, newAbs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Delete a file or folder within the repo. Uses the OS trash (Recycle Bin) so
// the action stays recoverable rather than a permanent unlink.
bridge.handle('delete-file', async (_e, rel) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, rel);
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Invalid path' };
    await shell.trashItem(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Open a repo-relative file in the OS's default program for its type — the asset
// viewer's "Open externally" button (a .glb in the system 3D viewer, an image in
// the default image app, …). Resolves the path against repoPath here so the
// renderer never has to know the absolute path.
bridge.handle('open-asset-external', async (_e, rel) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, rel);
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Invalid path' };
    const err = await shell.openPath(abs);
    return { ok: !err, error: err };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Reveal a repo-relative file or folder in the OS file browser (Explorer/Finder),
// selecting it within its parent folder.
bridge.handle('reveal-in-folder', (_e, rel) => {
  try {
    const repoPath = getRepoPath();
    const abs = path.join(repoPath, rel);
    const inside = path.relative(repoPath, abs);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return { ok: false, error: 'Invalid path' };
    shell.showItemInFolder(abs);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Read/write a repo-relative binary asset as base64 for the viewer/editor.
// Paths come from git porcelain (inside the repo), so no traversal guard.
bridge.handle('read-asset', async (_e, file) => {
  try {
    const abs = path.join(getRepoPath(), file);
    const ext = path.extname(abs).slice(1).toLowerCase();
    return { ok: true, base64: (await fs.promises.readFile(abs)).toString('base64'),
      mime: ASSET_MIME[ext] || 'application/octet-stream' };
  } catch (e) { return { ok: false, error: e.message }; }
});
bridge.handle('write-asset', async (_e, { file, base64 }) => {
  try { await fs.promises.writeFile(path.join(getRepoPath(), file), Buffer.from(base64, 'base64')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// A terminal PTY can't carry pasted image bytes, so when the clipboard holds a
// bitmap we spill it to a temp PNG and hand back the path; the renderer pastes
// that path into the session (as an "@<path>" mention Claude can read). Returns
// { ok: false } when the clipboard has no image, so the caller falls back to a
// normal text paste.
bridge.handle('paste-image', async () => {
  try {
    // Only the read can throw transiently (clipboard lock); an empty clipboard is
    // a valid "no image", so it returns null rather than retrying. fs work stays
    // outside the retry so a real write failure isn't retried as if it were a lock.
    const img = await withClipboardRetry(() => {
      const i = clipboard.readImage();
      return i.isEmpty() ? null : i;
    }, { fallback: null });
    if (!img) return { ok: false };
    const dir = path.join(os.tmpdir(), 'claude-ide-pastes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `paste-${Date.now()}.png`);
    fs.writeFileSync(file, img.toPNG());
    return { ok: true, path: file };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Terminal copy/paste goes through the main-process clipboard: the renderer's
// async navigator.clipboard is unreliable under file:// (not a secure context,
// so navigator.clipboard can be undefined and throw synchronously) and needs
// document focus the canvas can briefly lack right after a selection.
//
// Both calls retry: on Windows the clipboard is a single lock another process can
// briefly hold, so a bare readText()/writeText() intermittently throws
// "OpenClipboard failed". Without the retry that throw rejected the IPC call and
// the renderer's paste() swallowed the rejection, silently dropping the paste.
bridge.handle('clipboard-write', (_e, text) =>
  withClipboardRetry(() => { clipboard.writeText(text || ''); return true; }, { fallback: false }));
bridge.handle('clipboard-read', () =>
  withClipboardRetry(() => clipboard.readText(), { fallback: '' }));

// Auto-refresh the explorer tree when the repo changes on disk, so the user
// never has to hit a refresh button. One recursive fs.watch over the repo root
// catches create/rename/delete/edit at any depth (recursive is native on
// win32/darwin). Two cheap guards keep it from hurting performance:
//   1. Events whose top path segment is a skipped dir (node_modules, .git, build
//      output — see search-ignore.js) are dropped before they cost anything, so
//      a churning dependency/build dir never triggers a rebuild.
//   2. The rest are debounced into a single `tree-changed` per quiet window, so a
//      burst (git checkout, npm install of real source, save-all) collapses to
//      one renderer rebuild. A trailing-edge timer means the last event in a
//      burst always fires, so nothing is missed.
const TREE_DEBOUNCE_MS = 250;
let watcher = null;
let debounce = null;

function firstSegment(rel) {
  if (!rel) return '';
  const norm = rel.split(path.sep).join('/');
  const slash = norm.indexOf('/');
  return slash === -1 ? norm : norm.slice(0, slash);
}

function scheduleTreeChanged() {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; sendToRenderer('tree-changed'); }, TREE_DEBOUNCE_MS);
}

function watchRepo() {
  if (watcher) { watcher.close(); watcher = null; }
  if (debounce) { clearTimeout(debounce); debounce = null; }
  if (!getRepoPath()) return; // nothing to watch until a folder is opened
  try {
    watcher = fs.watch(getRepoPath(), { recursive: true }, (_event, filename) => {
      if (filename && shouldSkipDir(firstSegment(filename))) return;
      scheduleTreeChanged();
    });
    // A watcher error (e.g. the folder was deleted) shouldn't crash the app.
    watcher.on('error', () => { if (watcher) { watcher.close(); watcher = null; } });
  } catch (e) {
    console.error('[explorer watch failed]', e.message);
  }
}

watchRepo();
onRepoChange(watchRepo);

module.exports = {};
