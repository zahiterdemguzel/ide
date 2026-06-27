const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { git } = require('./git');
const { sessions, trackedFiles, setSessionState } = require('./sessions');
const { commitContent, inverseEdits } = require('./edit-ops');
const { sumNumstat } = require('./git-parse');

// Build one commit whose tree is HEAD with only `entries` applied — via a
// throwaway index + commit-tree, so the real index and the working tree are
// never touched. That's what lets two sessions that edited the SAME file each
// commit only their own hunks: we commit a synthesized blob, not whatever the
// shared working file currently holds. Each entry is either
//   { path, content }   — write/replace this blob (content is a string or Buffer,
//                          so a binary file a Bash tool produced commits intact)
//   { path, delete: true } — remove this path (a file the session moved out or rm'd)
async function commitBlobs(entries, msg) {
  const head = await git(['rev-parse', '-q', '--verify', 'HEAD']);
  const headSha = head.stdout.trim();
  const idxFile = path.join(os.tmpdir(), `ide-sess-idx-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };
  const staged = [];  // {path, sha} to sync into the real index after the commit
  const removed = []; // paths to drop from the real index after the commit
  try {
    const seed = headSha ? await git(['read-tree', headSha], { env }) : await git(['read-tree', '--empty'], { env });
    if (!seed.ok) return seed;
    for (const e of entries) {
      if (e.delete) {
        const upd = await git(['update-index', '--force-remove', e.path], { env });
        if (!upd.ok) return upd;
        removed.push(e.path);
        continue;
      }
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
    // Sync the REAL index for just these paths, so they read as clean against the
    // new HEAD and only the OTHER session's edits remain as unstaged changes.
    // Other paths in the index are left alone.
    for (const e of staged) await git(['update-index', '--cacheinfo', `100644,${e.sha},${e.path}`]);
    for (const p of removed) await git(['update-index', '--force-remove', p]);
    return ct;
  } finally {
    try { fs.unlinkSync(idxFile); } catch {}
  }
}

// Build the list of blob entries representing ONLY this session's changes vs
// HEAD — for each touched file, replay the session's own edits onto the committed
// (HEAD) version (another session's edits to the same file are left out). Shared
// by commit (which commits the entries) and diff (which renders them). Returns the
// entries plus bookkeeping the commit path needs: which abs paths each entry came
// from (to forget after committing) and which are phantom empty patches (nothing
// to commit, so they're pruned from tracking). `entries` items are either
// { path, content } (string|Buffer blob) or { path, delete: true }.
async function sessionEntries(s, repoPath) {
  const entries = [];
  const committedAbs = [];     // edited (text-op) paths folded in, to forget after a commit
  const committedFileOps = []; // path-level (binary/rename/delete) paths folded in, to forget after
  const emptyAbs = [];         // text-op paths whose net change vs HEAD is nothing (empty patch)
  const emptyFileOps = [];     // path-level paths that would commit nothing (already at HEAD, or gone)
  for (const [abs, ops] of s.edits) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    const headFile = await git(['show', `HEAD:${rel}`]);
    let working = null;
    try { working = fs.readFileSync(abs, 'utf8'); } catch { /* gone */ }
    const content = commitContent(headFile.ok ? headFile.stdout : '', ops, working);
    // content === null: an empty patch (replays back to HEAD) or the file is gone.
    // Either way there is nothing to commit, so drop it instead of committing a
    // no-op blob that inflates the file count and stages a diff-less change.
    if (content == null) { emptyAbs.push(abs); continue; }
    entries.push({ path: rel, content }); committedAbs.push(abs);
  }
  // Path-level changes a text op can't represent: a binary file the session
  // created (committed from its current bytes — read as a Buffer so it stays
  // intact), or a file it moved/removed (committed as a deletion).
  const seen = new Set(entries.map((e) => e.path));
  for (const [abs, kind] of s.fileOps) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || seen.has(rel)) continue; // outside the repo / already an edit
    if (kind === 'delete') {
      // Nothing committed at HEAD means there is nothing to delete — a phantom op.
      if (!(await git(['cat-file', '-e', `HEAD:${rel}`])).ok) { emptyFileOps.push(abs); continue; }
      entries.push({ path: rel, delete: true }); committedFileOps.push(abs); continue;
    }
    let buf = null;
    try { buf = fs.readFileSync(abs); } catch { /* vanished */ }
    if (buf == null) { emptyFileOps.push(abs); continue; }
    // Empty add: the current bytes already match what's committed at HEAD. Compare
    // by blob hash (binary-safe, same filters commitBlobs applies via --path).
    const headSha = await git(['rev-parse', '-q', '--verify', `HEAD:${rel}`]);
    if (headSha.ok) {
      const curSha = await git(['hash-object', '--path', rel, '--stdin'], { input: buf });
      if (curSha.ok && curSha.stdout.trim() === headSha.stdout.trim()) { emptyFileOps.push(abs); continue; }
    }
    entries.push({ path: rel, content: buf }); committedFileOps.push(abs);
  }
  return { entries, committedAbs, committedFileOps, emptyAbs, emptyFileOps };
}

// Render this session's combined changes (its entries vs HEAD) without touching
// the real index or working tree: seed a throwaway index from HEAD, write each
// entry's blob into it, then `git diff --cached` that index against HEAD. The
// numstat backs the Diff button's +added/-removed badge; the full patch (only
// fetched when `withPatch`) feeds the diff dialog. An empty entry set is "no
// change", so the button disables.
async function sessionDiff(s, repoPath, withPatch) {
  const { entries } = await sessionEntries(s, repoPath);
  const empty = { patch: '', additions: 0, deletions: 0, files: 0 };
  if (!entries.length) return empty;
  const idxFile = path.join(os.tmpdir(), `ide-sess-diff-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: idxFile };
  try {
    const head = await git(['rev-parse', '-q', '--verify', 'HEAD']);
    const headSha = head.stdout.trim();
    const seed = headSha ? await git(['read-tree', headSha], { env }) : await git(['read-tree', '--empty'], { env });
    if (!seed.ok) return empty;
    for (const e of entries) {
      if (e.delete) { await git(['update-index', '--force-remove', e.path], { env }); continue; }
      const hash = await git(['hash-object', '-w', '--stdin', '--path', e.path], { input: e.content });
      if (!hash.ok) continue;
      await git(['update-index', '--add', '--cacheinfo', `100644,${hash.stdout.trim()},${e.path}`], { env });
    }
    // --cached diffs the (throwaway) index against HEAD; with no HEAD it diffs the
    // empty tree, so a brand-new repo's first changes still show.
    const stat = await git(['diff', '--cached', '--numstat'], { env });
    const totals = sumNumstat(stat.ok ? stat.stdout : '');
    if (!withPatch) return { patch: '', ...totals };
    const patch = await git(['diff', '--cached'], { env });
    return { patch: patch.ok ? patch.stdout : '', ...totals };
  } finally {
    try { fs.unlinkSync(idxFile); } catch {}
  }
}

// Light pull for the Diff button's badge (counts only). The renderer refreshes it
// off each session-meta (so a background session's badge tracks its edits) and on
// restore/select.
ipcMain.handle('session-diff-stat', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { additions: 0, deletions: 0, files: 0 };
  return sessionDiff(s, getRepoPath(), false);
});

// Full patch for the Diff dialog (rendered over the terminal, terminal kept alive).
ipcMain.handle('session-diff', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, patch: '', additions: 0, deletions: 0, files: 0 };
  return { ok: true, ...(await sessionDiff(s, getRepoPath(), true)) };
});

// Commit ONLY the hunks this session edited, using its first prompt as the
// message. For each touched file we replay the session's own edits onto the
// committed (HEAD) version and commit that — so another session's edits to the
// same file are left uncommitted in the working tree. If an edit can't be
// replayed cleanly (the other session moved that text, or an opaque op), we fall
// back to the whole current file for that path.
ipcMain.handle('commit-session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const repoPath = getRepoPath();
  const { entries, committedAbs, committedFileOps, emptyAbs, emptyFileOps } = await sessionEntries(s, repoPath);
  // Empty patches are phantom changes — forget them unconditionally (regardless of
  // whether a real commit follows) so the tracked-file count stops counting them.
  let pruned = false;
  for (const abs of emptyAbs) if (s.edits.delete(abs)) pruned = true;
  for (const abs of emptyFileOps) if (s.fileOps.delete(abs)) pruned = true;
  if (!entries.length) {
    if (pruned) sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
    return { ok: false, stderr: 'This session changed no files yet' };
  }
  const msg = (s.firstPrompt || `session ${id.slice(0, 8)}`).slice(0, 500);
  const ct = await commitBlobs(entries, msg);
  // Forget what we committed so the button reads "nothing to commit" until the
  // session edits again — and a later commit only carries those new edits, not a
  // re-commit of blobs already at HEAD. Re-push the shrunk file list to the bar.
  if (ct.ok) {
    for (const abs of committedAbs) s.edits.delete(abs);
    for (const abs of committedFileOps) s.fileOps.delete(abs);
    setSessionState(id, 'pushed'); // mirror the renderer's purple dot, and persist it
  }
  if (ct.ok || pruned) sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
  return ct;
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
  const repoPath = getRepoPath();
  const sharedWithOther = (abs) => [...sessions].some(([sid, o]) => sid !== id && (o.edits.has(abs) || o.fileOps.has(abs)));
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
  // Undo path-level changes (binary creates, renames/moves, deletes). `git
  // checkout HEAD -- <rel>` restores the committed bytes (binary-safe), and an
  // 'add' with no HEAD version was new this session, so it's unlinked. A path
  // another session also touched is skipped — clobbering its work is worse.
  const revertedOps = [];
  for (const [abs, kind] of s.fileOps) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    if (sharedWithOther(abs)) { skipped.push(rel); continue; }
    const inHead = (await git(['cat-file', '-e', `HEAD:${rel}`])).ok;
    if (inHead) {
      const r = await git(['checkout', 'HEAD', '--', rel]); // restore the committed file (add modified it, or delete removed it)
      if (!r.ok) { skipped.push(rel); continue; }
    } else if (kind === 'add') {
      try { fs.unlinkSync(abs); } catch {} // file was new this session
    }
    revertedOps.push(abs);
  }
  for (const abs of revertedOps) s.fileOps.delete(abs);
  sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
  if (!reverted.length && !revertedOps.length && !skipped.length) return { ok: false, stderr: 'This session changed no files' };
  return { ok: true, reverted: reverted.length + revertedOps.length, skipped };
});

module.exports = {};
