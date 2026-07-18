const bridge = require('./remote-bridge');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { sendToRenderer } = require('./window');
const { getRepoPath } = require('./repo');
const { git } = require('./git');
const { sessions, trackedFiles, pathClaimedByOther, setSessionState, persistSession, guard } = require('./sessions');
const { commitContent, inverseEdits } = require('./edit-ops');
const { companionPaths } = require('./companion-files');
const { sumNumstat } = require('./git-parse');
const { runHaiku } = require('./claude');
const { commitMessagePrompt, cleanCommitMessage, fallbackCommitMessage } = require('./commit-msg');
const { createLimiter } = require('./concurrency');

// Haiku can be slow (or its CLI fallback can hang); cap the per-session message
// generation so the commit button never spins indefinitely. On timeout we commit
// with the deterministic session-title fallback instead.
const COMMIT_MSG_TIMEOUT_MS = 30000;

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
    // --add: --cacheinfo refuses a path not already in the index (a file the
    // session newly created), which would leave HEAD ahead of the index and
    // surface as a phantom staged-delete + untracked pair. --add covers both the
    // new-path and update-existing cases.
    for (const e of staged) await git(['update-index', '--add', '--cacheinfo', `100644,${e.sha},${e.path}`]);
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
    // A fileOp is filled by a GLOBAL working-tree diff, so a file ANOTHER session
    // edited (via the exact, per-session text-edit signal) while this session's
    // Bash/MCP tool ran can be mis-recorded here. That file is the other session's
    // work; committing it as a whole-file blob would sweep in their edits. Drop it
    // and forget it from tracking — text-edit ownership wins. This also self-heals a
    // fileOp recorded before the fix (or before the other session's edit landed).
    if (pathClaimedByOther(s, abs, { edits: true, fileOps: false })) { emptyFileOps.push(abs); continue; }
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
  // Fold in Godot sidecars (`<file>.uid`, `<file>.import`) for every resource we're
  // committing. The editor writes these next to the file — the agent's edit tools
  // never touch them, so they're absent from s.edits/s.fileOps and would otherwise
  // be left behind, breaking the import. They're recomputed from disk each time (not
  // tracked in s.edits/s.fileOps), so there's nothing to forget after a commit.
  // Iterate a snapshot of entries so the companions we append don't recurse.
  const present = new Set(entries.map((e) => e.path));
  for (const e of [...entries]) {
    for (const comp of companionPaths(e.path)) {
      if (present.has(comp)) continue;
      const compAbs = path.join(repoPath, comp.split('/').join(path.sep));
      // Never sweep in a sidecar another live session is editing/creating.
      if (pathClaimedByOther(s, compAbs, { edits: true, fileOps: true })) continue;
      let buf = null;
      try { buf = fs.readFileSync(compAbs); } catch { /* missing on disk */ }
      if (e.delete) {
        // The resource is being deleted; drop its committed sidecar if the editor
        // removed it from disk too (a sidecar that survives at HEAD is orphaned).
        if (buf == null && (await git(['cat-file', '-e', `HEAD:${comp}`])).ok) {
          entries.push({ path: comp, delete: true }); present.add(comp);
        }
        continue;
      }
      if (buf == null) continue; // no sidecar on disk to add
      // Skip an unchanged sidecar (current bytes already match HEAD) so it doesn't
      // inflate the commit with a diff-less blob — same blob-hash check as binary adds.
      const headSha = await git(['rev-parse', '-q', '--verify', `HEAD:${comp}`]);
      if (headSha.ok) {
        const curSha = await git(['hash-object', '--path', comp, '--stdin'], { input: buf });
        if (curSha.ok && curSha.stdout.trim() === headSha.stdout.trim()) continue;
      }
      entries.push({ path: comp, content: buf }); present.add(comp);
    }
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
  // No folder open (fresh launch before a project is picked): there is no repo to
  // diff against, so report "no change" instead of letting path.relative(null) throw.
  if (!repoPath) return { patch: '', additions: 0, deletions: 0, files: 0 };
  const { entries } = await sessionEntries(s, repoPath);
  return entriesToDiff(entries, withPatch);
}

// Diff a precomputed entry set against HEAD via a throwaway index — the body of
// sessionDiff, split out so commit-session can render the patch for the SAME
// frozen entries it is about to commit (for the message prompt) without rebuilding
// them off the live, still-changing working tree.
async function entriesToDiff(entries, withPatch) {
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
// restore/select. Requests arrive in bursts (startup, a tab switch, a git refresh
// fanning out to every visible session) and each one spawns several git processes,
// so they run through a limiter instead of all at once.
const limitDiffStat = createLimiter(3);
bridge.handle('session-diff-stat', guard('reading a session diff', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { additions: 0, deletions: 0, files: 0 };
  return limitDiffStat(() => sessionDiff(s, getRepoPath(), false));
}, { additions: 0, deletions: 0, files: 0 }));

// Full patch for the Diff dialog (rendered over the terminal, terminal kept alive).
bridge.handle('session-diff', guard('reading a session diff', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, patch: '', additions: 0, deletions: 0, files: 0 };
  return { ok: true, ...(await sessionDiff(s, getRepoPath(), true)) };
}, { ok: false, patch: '', additions: 0, deletions: 0, files: 0 }));

// Author a commit message from this session's OWN diff (the same patch the Diff
// dialog shows), via Haiku — so the message describes the actual code change, not
// the session's first conversational prompt. Bounded by COMMIT_MSG_TIMEOUT_MS;
// on timeout/failure/empty-diff we fall back to the session title.
async function sessionCommitMessage(s, id, patch) {
  if (patch && patch.trim()) {
    const out = await Promise.race([
      runHaiku(commitMessagePrompt(patch)),
      new Promise((resolve) => setTimeout(() => resolve(null), COMMIT_MSG_TIMEOUT_MS)),
    ]);
    const cleaned = cleanCommitMessage(out);
    if (cleaned) return cleaned;
  }
  return fallbackCommitMessage({ name: s.name, firstPrompt: s.firstPrompt, id });
}

// Commit ONLY the hunks this session edited. For each touched file we replay the
// session's own edits onto the committed (HEAD) version and commit that — so
// another session's edits to the same file are left uncommitted in the working
// tree. If an edit can't be replayed cleanly (the other session moved that text,
// or an opaque op), we fall back to the whole current file for that path.
//
// The message is generated from this session's diff via Haiku, which can take a
// few seconds. We SNAPSHOT and clear the session's tracking up front, before that
// await, so a session that keeps running during generation accumulates its new
// edits as a SEPARATE batch — they are never folded into this commit. If the
// commit then fails we restore the snapshot so the work isn't silently dropped.
bridge.handle('commit-session', guard('committing a session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const repoPath = getRepoPath();
  if (!repoPath) return { ok: false, stderr: 'No folder open' };
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

  // Freeze the committed paths' tracking NOW (at click), so edits the session
  // makes while the message generates land in a fresh batch, not this commit.
  // `entries` already holds the frozen blob content, so the commit itself is
  // unaffected by later working-tree changes regardless; clearing here is what
  // keeps the NEXT commit (and the bar's file count) correctly scoped.
  const editSnap = committedAbs.map((abs) => ({ abs, ops: s.edits.get(abs) }));
  const fileOpSnap = committedFileOps.map((abs) => ({ abs, kind: s.fileOps.get(abs) }));
  for (const abs of committedAbs) s.edits.delete(abs);
  for (const abs of committedFileOps) s.fileOps.delete(abs);
  persistSession(id);
  sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });

  const { patch } = await entriesToDiff(entries, true);
  const msg = await sessionCommitMessage(s, id, patch);
  const ct = await commitBlobs(entries, msg);
  if (ct.ok) {
    setSessionState(id, 'pushed'); // mirror the renderer's purple dot, and persist it
    persistSession(id);
    sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
  } else {
    // The commit failed after we cleared tracking — restore the snapshot (newer
    // edits, if any arrived during generation, stay ahead of the restored ops) so
    // the user can retry. The working-tree changes were never touched.
    for (const { abs, ops } of editSnap) s.edits.set(abs, [...ops, ...(s.edits.get(abs) || [])]);
    for (const { abs, kind } of fileOpSnap) if (!s.fileOps.has(abs)) s.fileOps.set(abs, kind);
    persistSession(id);
    sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
  }
  return ct;
}, (err) => ({ ok: false, stderr: err && err.message ? err.message : String(err) })));

// Revert ONLY this session's working-tree changes by de-applying its own edits,
// so another session's edits to the same file survive. For each touched file we
// back its ops out of the current working contents (inverseEdits). If an op
// can't be inverted (a full Write, opaque, or moved text), a hard reset to HEAD
// is only safe when NO other live session also edited that file — otherwise we
// skip it (clobbering another agent's work is worse than leaving ours). Reverted
// files are forgotten so a later commit/revert won't double-apply them.
bridge.handle('revert-session', guard('reverting a session', async (_e, id) => {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const repoPath = getRepoPath();
  if (!repoPath) return { ok: false, stderr: 'No folder open' };
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
  if (reverted.length || revertedOps.length) persistSession(id); // the forgotten edits must reach disk
  sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: trackedFiles(s) });
  if (!reverted.length && !revertedOps.length && !skipped.length) return { ok: false, stderr: 'This session changed no files' };
  return { ok: true, reverted: reverted.length + revertedOps.length, skipped };
}, (err) => ({ ok: false, stderr: err && err.message ? err.message : String(err) })));

module.exports = {};
