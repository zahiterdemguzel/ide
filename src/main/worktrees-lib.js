// Pure logic behind git worktree sessions: naming, porcelain parsing, and what
// the seeding copy must carry across. No electron, no fs, no child_process — so
// it's unit-tested directly (worktrees.js owns the IO and IPC).

const path = require('path');

// Worktrees live inside the project, next to the other per-project tooling state.
// Keeping them in-tree means they travel with the folder and are obvious in a
// file listing; the trade-off is that everything which walks the project has to
// skip this one path (see IGNORED_SEGMENT below).
const WORKTREES_REL = '.claude/worktrees';

// A `*` .gitignore inside the worktrees directory hides every worktree from the
// PARENT repo's status without touching the project's own .gitignore. It ignores
// itself too, which is what we want: nothing under here is ever tracked.
const WORKTREES_GITIGNORE = '*\n';

// Deterministic names derived from the session id, so a worktree can always be
// matched back to its session (and vice versa) with no extra bookkeeping. The
// DIRECTORY name is permanent — a live PTY's cwd, any launch-config terminal and
// every absolute path inside node_modules point at it, so it must never be
// renamed while the session lives. The BRANCH may be renamed later, once the
// session earns a real title, because a branch rename moves no files.
const worktreeName = (id) => `sess-${String(id || '').replace(/-/g, '').slice(0, 8) || 'unknown'}`;
const branchNameFor = (id) => `ide/${worktreeName(id)}`;

// Absolute path of a project's worktrees directory / one worktree inside it.
const worktreesRoot = (mainRepo) => path.join(mainRepo, ...WORKTREES_REL.split('/'));
const worktreePath = (mainRepo, id) => path.join(worktreesRoot(mainRepo), worktreeName(id));

// Turn a session title into a readable branch name. Mirrors the rules of the
// renderer's normalizeBranchName (src/renderer/shared/git-status.js) — which main
// can't import, since it's an ES module in the renderer bundle — plus git's own
// ref constraints: no spaces, no `~^:?*[\`, no leading/trailing dot or slash, no
// `..`, no trailing `.lock`. Returns '' when nothing usable survives, and the
// caller then keeps the id-based name.
function branchSlug(title) {
  const slug = String(title || '')
    .trim().toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
    .replace(/[-.]+$/, '');
  if (!slug || slug === 'lock' || slug.endsWith('.lock')) return '';
  return slug;
}

// The branch to rename a session's worktree branch to once it has a title.
// Keeps the id suffix so two sessions that Haiku titles identically can't
// collide, and so the branch still points back at its session.
function titledBranchFor(id, title) {
  const slug = branchSlug(title);
  return slug ? `ide/${slug}-${worktreeName(id).slice(-4)}` : '';
}

// `git worktree list --porcelain`: stanzas separated by blank lines, each a set
// of `key value` (or bare-key) lines. We care about the path, the checked-out
// branch (absent when detached), and whether git considers it stale/locked.
function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) { if (cur) { out.push(cur); cur = null; } continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? '' : line.slice(sp + 1);
    if (key === 'worktree') { if (cur) out.push(cur); cur = { path: value, head: '', branch: '', detached: false, locked: false, prunable: false }; continue; }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out.filter((w) => w.path);
}

// Paths that must never be copied into a new worktree, whatever git reports:
// the repo's own metadata, and the worktrees directory itself (copying it would
// recurse into every sibling worktree — potentially gigabytes, and nonsense).
const NEVER_COPY = ['.git', WORKTREES_REL, '.claude/worktrees'];

// True when `p` is `root` or lives under it. Both are '/'-separated repo-relative
// paths, so this is a plain prefix test rather than a filesystem question.
function isUnder(p, root) {
  const a = p.replace(/\/+$/, '');
  const b = root.replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/');
}

// What the seeding copy has to carry across, from
// `git status --porcelain=v1 --untracked-files=all --ignored=matching`.
//
// `git worktree add` materializes every TRACKED file already, so the only thing
// missing from a fresh worktree is what git doesn't manage: untracked files
// (`??`) and ignored ones (`!!`) — .env, build output, node_modules. That's
// exactly the set that makes the project actually runnable, and it's why this
// copy is not limited to tracked files.
//
// `--ignored=matching` reports a wholly-ignored directory as ONE row
// (`!! node_modules/`), so a 30k-file dependency tree costs one entry here and
// one recursive copy rather than 30k of each.
function copyRoots(porcelain) {
  const roots = [];
  const seen = new Set();
  for (const raw of String(porcelain || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (code !== '??' && code !== '!!') continue;
    const p = line.slice(3).replace(/^"|"$/g, '').replace(/\/+$/, '');
    if (!p || seen.has(p)) continue;
    if (NEVER_COPY.some((skip) => isUnder(p, skip))) continue;
    seen.add(p);
    roots.push({ path: p, ignored: code === '!!', dir: line.slice(3).endsWith('/') });
  }
  return roots;
}

// Drop the roots the user unchecked in the pre-scan (and anything nested under
// one). Skipping `node_modules` must also skip `node_modules/.cache`, even if
// git listed them separately.
function applySkipList(roots, skip) {
  const skipped = (skip || []).filter(Boolean).map((s) => s.replace(/\/+$/, ''));
  if (!skipped.length) return roots.slice();
  return roots.filter((r) => !skipped.some((s) => isUnder(r.path, s)));
}

// The pre-scan rows the create dialog shows: the heaviest copy roots first, so
// the user can drop a 2 GB node_modules before waiting for it. Anything below the
// threshold isn't worth a checkbox — it's copied silently.
function prescanRows(sized, minBytes = 5 * 1024 * 1024) {
  return (sized || [])
    .filter((r) => r && r.bytes >= minBytes)
    .slice()
    .sort((a, b) => b.bytes - a.bytes);
}

// git reports a conflicted merge on stdout as much as stderr, and the wording is
// stable across versions. Matching only these means an auth/lock/checkout failure
// is NOT mistaken for a conflict the user could hand to Claude.
function isMergeConflict(text) {
  const s = String(text || '');
  return /^CONFLICT \(/m.test(s)
    || /Automatic merge failed; fix conflicts/m.test(s)
    || /error: could not apply/m.test(s);
}

// Guard verdict for removing a worktree. Live processes are a hard stop (their
// cwd would be pulled out from under them); everything else is a warning the
// user can override, because the work is still recoverable from the branch.
function removeVerdict({ live = false, dirty = false, unmerged = 0, unpushed = 0 } = {}) {
  if (live) return { allow: false, reason: 'live' };
  const warn = [];
  if (dirty) warn.push('dirty');
  if (unmerged > 0) warn.push('unmerged');
  if (unpushed > 0) warn.push('unpushed');
  return { allow: true, reason: warn[0] || '', warn };
}

module.exports = {
  WORKTREES_REL, WORKTREES_GITIGNORE, NEVER_COPY,
  worktreeName, branchNameFor, worktreesRoot, worktreePath,
  branchSlug, titledBranchFor, parseWorktreeList,
  isUnder, copyRoots, applySkipList, prescanRows, isMergeConflict, removeVerdict,
};
