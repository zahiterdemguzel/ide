const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { getWin } = require('./window');
const { getRepoPath } = require('./repo');
const { git } = require('./git');
const { sessions } = require('./sessions');
const { replayEdits, inverseEdits } = require('./edit-ops');

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
  const repoPath = getRepoPath();
  const entries = [];
  const committedAbs = []; // paths actually folded into this commit, to forget after
  for (const [abs, ops] of s.edits) {
    const rel = path.relative(repoPath, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) continue; // outside the repo
    const headFile = await git(['show', `HEAD:${rel}`]);
    const { content, clean } = replayEdits(headFile.ok ? headFile.stdout : '', ops);
    if (clean) { entries.push({ path: rel, content }); committedAbs.push(abs); continue; }
    try { entries.push({ path: rel, content: fs.readFileSync(abs, 'utf8') }); committedAbs.push(abs); } catch { /* gone */ }
  }
  if (!entries.length) return { ok: false, stderr: 'This session changed no files yet' };
  const msg = (s.firstPrompt || `session ${id.slice(0, 8)}`).slice(0, 500);
  const ct = await commitBlobs(entries, msg);
  // Forget what we committed so the button reads "nothing to commit" until the
  // session edits again — and a later commit only carries those new edits, not a
  // re-commit of blobs already at HEAD. Re-push the shrunk file list to the bar.
  if (ct.ok) {
    for (const abs of committedAbs) s.edits.delete(abs);
    const win = getWin();
    if (win) win.webContents.send('session-meta', { id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] });
  }
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
  const win = getWin();
  if (win) win.webContents.send('session-meta', { id, firstPrompt: s.firstPrompt || '', files: [...s.edits.keys()] });
  if (!reverted.length && !skipped.length) return { ok: false, stderr: 'This session changed no files' };
  return { ok: true, reverted: reverted.length, skipped };
});

module.exports = {};
