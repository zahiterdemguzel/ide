const bridge = require('./remote-bridge');
const path = require('path');
const fs = require('fs');
const { git, repoWrite } = require('./git');
const { getMainRepoPath, onRepoChange } = require('./repo');
const { sendToRenderer } = require('./window');
const {
  WORKTREES_GITIGNORE, worktreeName, branchNameFor, worktreesRoot, worktreePath,
  parseWorktreeList, copyRoots, applySkipList, prescanRows, removeVerdict, titledBranchFor,
} = require('./worktrees-lib');

// --- git worktrees ---
// A worktree session runs in its own checkout under <project>/.claude/worktrees,
// so several sessions can build and test in parallel without sharing one working
// tree. This module owns the IO: creating, seeding, listing and removing those
// trees. The naming/parsing/guard logic is pure and lives in worktrees-lib.js.

// Windows caps paths at 260 chars unless they're prefixed \\?\. A worktree adds
// ~30 chars of its own and then a node_modules tree nests deep inside it, so the
// seeding copy blows that cap on perfectly ordinary projects. Every path the
// walker hands to fs gets the prefix; git itself handles long paths on its own.
function longPath(p) {
  if (process.platform !== 'win32') return p;
  const abs = path.resolve(p);
  return abs.startsWith('\\\\?\\') ? abs : '\\\\?\\' + abs;
}

// Can this project host worktrees at all? Two hard preconditions, both of which
// make `git worktree add` fail outright rather than degrade:
//   - it must be a git repo;
//   - it must have a commit. `worktree add -b <branch> HEAD` cannot resolve an
//     unborn HEAD, so a repo whose first commit hasn't been made yet is out.
// The renderer uses this to disable the toggle with a reason instead of letting
// session creation fail later, when the user has already typed a prompt.
async function worktreeSupport() {
  const cwd = getMainRepoPath();
  if (!cwd) return { ok: false, reason: 'no-folder' };
  const inTree = await git(['rev-parse', '--is-inside-work-tree'], { cwd });
  if (!inTree.ok || inTree.stdout.trim() !== 'true') return { ok: false, reason: 'not-a-repo' };
  const head = await git(['rev-parse', '-q', '--verify', 'HEAD'], { cwd });
  if (!head.ok || !head.stdout.trim()) return { ok: false, reason: 'no-commits' };
  return { ok: true, reason: '' };
}

// The worktrees directory carries a `*` .gitignore so every worktree is invisible
// to the parent repo's status. Written BEFORE the first `worktree add`, so the new
// checkout never shows up as a pile of untracked files even momentarily.
function ensureWorktreesDir(main) {
  const dir = worktreesRoot(main);
  fs.mkdirSync(longPath(dir), { recursive: true });
  const ignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(longPath(ignore))) fs.writeFileSync(longPath(ignore), WORKTREES_GITIGNORE);
  return dir;
}

// Everything git does not materialize in a fresh worktree: untracked + ignored.
// `--ignored=matching` collapses a wholly-ignored directory into a single row, so
// node_modules costs one entry instead of thirty thousand.
const SEED_STATUS_ARGS = ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'];

async function seedRoots(main, skip) {
  const r = await git(SEED_STATUS_ARGS, { cwd: main });
  if (!r.ok) return { ok: false, stderr: r.stderr, roots: [] };
  return { ok: true, roots: applySkipList(copyRoots(r.stdout), skip), stderr: '' };
}

// Walk a file or directory, accumulating {files, bytes}. lstat (never stat) so a
// symlink is measured as a link rather than followed — node_modules/.bin is full
// of them, and following can loop or count a target tree many times over.
function measure(abs, acc = { files: 0, bytes: 0 }) {
  let st;
  try { st = fs.lstatSync(longPath(abs)); } catch { return acc; }
  if (st.isSymbolicLink()) { acc.files++; return acc; }
  if (st.isDirectory()) {
    let ents = [];
    try { ents = fs.readdirSync(longPath(abs)); } catch { return acc; }
    for (const name of ents) measure(path.join(abs, name), acc);
    return acc;
  }
  acc.files++;
  acc.bytes += st.size;
  return acc;
}

// Copy one root (file, directory or symlink) from the project into the worktree.
// Throws CANCELED as soon as the token flips, so a multi-gigabyte node_modules
// can be abandoned promptly rather than after it finishes.
const CANCELED = 'worktree-copy-canceled';

function copyEntry(srcAbs, dstAbs, token, tick) {
  if (token && token.canceled) throw new Error(CANCELED);
  let st;
  try { st = fs.lstatSync(longPath(srcAbs)); } catch { return; } // vanished mid-copy
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(longPath(srcAbs)); } catch { return; }
    try {
      fs.symlinkSync(target, longPath(dstAbs), st.isDirectory() ? 'junction' : 'file');
    } catch {
      // Windows without developer mode refuses symlink creation for a normal
      // user. Fall back to copying what the link points at, so the worktree is
      // still runnable — a real file costs disk but never breaks a build.
      try { fs.copyFileSync(longPath(path.resolve(path.dirname(srcAbs), target)), longPath(dstAbs)); } catch { /* dangling link */ }
    }
    tick(1, 0);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(longPath(dstAbs), { recursive: true });
    let ents = [];
    try { ents = fs.readdirSync(longPath(srcAbs)); } catch { return; }
    for (const name of ents) copyEntry(path.join(srcAbs, name), path.join(dstAbs, name), token, tick);
    return;
  }
  fs.mkdirSync(longPath(path.dirname(dstAbs)), { recursive: true });
  fs.copyFileSync(longPath(srcAbs), longPath(dstAbs));
  tick(1, st.size);
}

// Pre-scan for the create dialog: the heavy copy roots, with sizes, so the user
// can drop a 2 GB dependency tree before waiting for it. Cached per project by
// the renderer; cheap enough to recompute (it stats, it doesn't read).
async function prescan() {
  const main = getMainRepoPath();
  if (!main) return { ok: false, rows: [], stderr: 'No folder open' };
  const { ok, roots, stderr } = await seedRoots(main, []);
  if (!ok) return { ok: false, rows: [], stderr };
  const sized = roots.map((r) => ({ path: r.path, ...measure(path.join(main, r.path.split('/').join(path.sep))) }));
  const total = sized.reduce((a, r) => ({ files: a.files + r.files, bytes: a.bytes + r.bytes }), { files: 0, bytes: 0 });
  return { ok: true, rows: prescanRows(sized), total, stderr: '' };
}

// In-flight copies, so a cancel from the renderer can reach the walker.
const copyTokens = new Map(); // session id -> { canceled }

// Create and seed a worktree for a session. Returns the paths the session record
// needs, or `{ ok: false, code }` — never a half-built tree: any failure past the
// `worktree add` rolls the whole thing back.
async function createWorktree({ id, skip = [], onProgress } = {}) {
  const main = getMainRepoPath();
  if (!main) return { ok: false, code: 'no-folder' };
  const support = await worktreeSupport();
  if (!support.ok) return { ok: false, code: support.reason };

  // The branch we'll merge back into. A detached HEAD has no branch to return to,
  // so refuse up front rather than stranding the session's work on a nameless ref.
  const baseRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: main });
  const base = baseRes.ok ? baseRes.stdout.trim() : '';
  if (!base || base === 'HEAD') return { ok: false, code: 'detached' };

  const dir = worktreePath(main, id);
  const branch = branchNameFor(id);
  try { ensureWorktreesDir(main); } catch (e) { return { ok: false, code: 'mkdir', stderr: String(e && e.message || e) }; }

  const add = await git(['worktree', 'add', '-b', branch, dir, base], { cwd: main });
  if (!add.ok) return { ok: false, code: 'add', stderr: add.stderr };

  const token = { canceled: false };
  copyTokens.set(id, token);
  try {
    const { ok, roots, stderr } = await seedRoots(main, skip);
    if (!ok) throw new Error(stderr || 'status failed');
    const total = roots.reduce((a, r) => {
      const m = measure(path.join(main, r.path.split('/').join(path.sep)));
      return { files: a.files + m.files, bytes: a.bytes + m.bytes };
    }, { files: 0, bytes: 0 });

    let files = 0, bytes = 0, last = 0, current = '';
    const tick = (f, b) => {
      files += f; bytes += b;
      // ~10 updates/sec: a progress bar doesn't need 30k IPC messages.
      const now = Date.now();
      if (now - last < 100) return;
      last = now;
      if (onProgress) onProgress({ id, files, bytes, totalFiles: total.files, totalBytes: total.bytes, current });
    };
    for (const r of roots) {
      current = r.path;
      const rel = r.path.split('/').join(path.sep);
      copyEntry(path.join(main, rel), path.join(dir, rel), token, tick);
    }
    if (onProgress) onProgress({ id, files, bytes, totalFiles: total.files, totalBytes: total.bytes, current: '', done: true });
    return { ok: true, worktree: dir, branch, baseBranch: base, main, files, bytes };
  } catch (e) {
    const canceled = e && e.message === CANCELED;
    await rollback(main, dir, branch);
    return { ok: false, code: canceled ? 'canceled' : 'copy', stderr: canceled ? '' : String(e && e.message || e) };
  } finally {
    copyTokens.delete(id);
  }
}

// Undo a half-built worktree. --force because the tree holds the partially copied
// ignored files (that's why the copy runs INTO the worktree git created, not into
// a bare directory we'd have to convert afterwards).
async function rollback(main, dir, branch) {
  await git(['worktree', 'remove', '--force', dir], { cwd: main });
  try { fs.rmSync(longPath(dir), { recursive: true, force: true }); } catch { /* already gone */ }
  if (branch) await git(['branch', '-D', branch], { cwd: main });
  await git(['worktree', 'prune'], { cwd: main });
}

function cancelCreate(id) {
  const token = copyTokens.get(id);
  if (!token) return false;
  token.canceled = true;
  return true;
}

// A worktree is created before its session has a name — names are authored from
// the first prompt, which hasn't happened yet — so it starts on an id-based
// branch. Once the title lands, rename the branch to something readable: `ide/
// fix-the-parser-2b3a`, keeping an id suffix so two identically-titled sessions
// can't collide. The DIRECTORY is never renamed; a live PTY's cwd, any launch
// config running in it and every absolute path inside node_modules point at it.
// A branch rename moves no files, so it is safe mid-session.
//
// Serialized through repoWrite, the same lock a merge takes: otherwise a rename
// could land between the merge reading the branch name and using it.
async function renameSessionBranch({ id, branch, title } = {}) {
  const main = getMainRepoPath();
  const next = titledBranchFor(id, title);
  if (!main || !branch || !next || next === branch) return '';
  return repoWrite(async () => {
    // Never claim a name that already exists — keep the id-based one instead.
    const taken = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${next}`], { cwd: main });
    if (taken.ok && taken.stdout.trim()) return '';
    const r = await git(['branch', '-m', branch, next], { cwd: main });
    return r.ok ? next : '';
  });
}

async function listWorktrees() {
  const main = getMainRepoPath();
  if (!main) return { ok: false, worktrees: [] };
  const r = await git(['worktree', 'list', '--porcelain'], { cwd: main });
  if (!r.ok) return { ok: false, worktrees: [], stderr: r.stderr };
  const all = parseWorktreeList(r.stdout);
  return { ok: true, main, worktrees: all.filter((w) => path.resolve(w.path) !== path.resolve(main)) };
}

// Stale registrations accumulate when a worktree directory is deleted outside the
// app (a manual rm, a cleanup script). Pruning at project-open keeps `worktree
// list` honest, which every guard below reads.
async function pruneWorktrees() {
  const main = getMainRepoPath();
  if (main) await git(['worktree', 'prune'], { cwd: main });
}

// Remove a worktree, with the guards the renderer already asked about via
// `worktree-status`. `force` skips the recoverable warnings, never the live check
// — that one is enforced by the caller, which knows about sessions and consoles.
async function removeWorktree({ dir, branch, deleteBranch = false } = {}) {
  const main = getMainRepoPath();
  if (!main || !dir) return { ok: false, stderr: 'No folder open' };
  const rm = await git(['worktree', 'remove', '--force', dir], { cwd: main });
  try { fs.rmSync(longPath(dir), { recursive: true, force: true }); } catch { /* already gone */ }
  await git(['worktree', 'prune'], { cwd: main });
  if (deleteBranch && branch) {
    // -D, not -d: the caller has already shown the unmerged warning and the user
    // chose to delete anyway; -d would just fail here and leave a stray branch.
    const del = await git(['branch', '-D', branch], { cwd: main });
    if (!del.ok) return { ok: rm.ok, branchError: del.stderr };
  }
  return { ok: rm.ok, stderr: rm.stderr };
}

// Everything the removal/close dialogs need to describe what would be lost.
// `live` is supplied by the caller (sessions.js knows which trees still have a
// running PTY or console); everything else is read from git here.
async function worktreeStatus({ dir, branch, baseBranch, live = false } = {}) {
  const main = getMainRepoPath();
  const out = { exists: false, dirty: false, dirtyFiles: 0, unmerged: 0, unpushed: 0, merged: false, live };
  if (!main || !dir) return { ...out, verdict: removeVerdict(out) };
  out.exists = fs.existsSync(longPath(path.join(dir, '.git')));
  if (!out.exists) return { ...out, verdict: removeVerdict(out) };
  const st = await git(['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: dir });
  const dirtyLines = st.ok ? st.stdout.split('\n').filter((l) => l.trim()) : [];
  out.dirty = dirtyLines.length > 0;
  out.dirtyFiles = dirtyLines.length;
  if (branch && baseBranch) {
    const ahead = await git(['rev-list', '--count', `${baseBranch}..${branch}`], { cwd: main });
    out.unmerged = ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0;
    // Merged means "this work is already somewhere the project keeps", which is
    // either the branch it was cut from or the branch the project is on now --
    // merging targets the live HEAD, so a session merged after a branch switch
    // must not be reported as unmerged when it is closed.
    const anc = await git(['merge-base', '--is-ancestor', branch, baseBranch], { cwd: main });
    out.merged = anc.ok;
    if (!out.merged) {
      const ancHead = await git(['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: main });
      out.merged = ancHead.ok;
      if (out.merged) out.unmerged = 0;
    }
    const up = await git(['rev-list', '--count', `@{u}..${branch}`], { cwd: main });
    out.unpushed = up.ok ? Number(up.stdout.trim()) || 0 : 0;
  }
  return { ...out, verdict: removeVerdict(out) };
}

// Prune when a PROJECT is opened (not on every worktree switch — those are
// frequent and change nothing on disk). A worktree directory deleted outside the
// app leaves a stale registration behind, and every guard below reads
// `worktree list`, so it has to be honest before anything else runs.
onRepoChange((active) => { if (active && active === getMainRepoPath()) pruneWorktrees().catch(() => {}); });

bridge.handle('worktree-support', () => worktreeSupport());
bridge.handle('worktree-prescan', () => prescan());
bridge.handle('worktree-list', () => listWorktrees());
bridge.handle('worktree-status', (_e, opts) => worktreeStatus(opts || {}));
bridge.handle('worktree-cancel', (_e, id) => cancelCreate(id));
bridge.handle('worktree-remove', (_e, opts) => removeWorktree(opts || {}));

// Progress is pushed rather than polled: the copy is one long synchronous-ish
// walk, and the renderer needs to paint a bar during it.
const emitProgress = (msg) => sendToRenderer('worktree-progress', msg);

module.exports = {
  worktreeSupport, createWorktree, cancelCreate, removeWorktree, worktreeStatus, renameSessionBranch,
  listWorktrees, pruneWorktrees, rollback, emitProgress, worktreeName, longPath,
};
