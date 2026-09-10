const bridge = require('./remote-bridge');
const { git, repoWrite } = require('./git');
const { sendToRenderer } = require('./window');
const { sessions, setSessionState, persistSession, guard } = require('./sessions');
const { sessionCommitMessage } = require('./session-commit');
const { isMergeConflict } = require('./worktrees-lib');

// --- merge a worktree session back into the project ---
// A worktree session owns its whole checkout, so "commit only this session's
// hunks" (session-commit.js) has nothing to disentangle here: everything in the
// tree is this session's work. Its button is therefore Merge, not Commit, and it
// means one thing end to end — land this session's branch on the base branch.
//
// The order matters. Any INTEGRATION (pulling the base branch's newer commits in)
// happens inside the WORKTREE, where a conflict can be resolved by the session
// that caused it without the project's own working tree ever being left half
// merged. Only once the branch already contains the base does the main tree
// merge, which by then cannot conflict.

// The whole sequence runs under repoWrite, the same global mutex the per-session
// commit and the git pane's commit/amend/undo take: it reads the base branch, works
// for seconds (a commit-model call), then moves the base branch's ref. Two merges
// racing would each build on the ref the other is about to replace.
async function mergeSession(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, stderr: 'Session is gone' };
  const { worktree: W, repo: M, branch: B } = s;
  if (!W || !B) return { ok: false, code: 'not-a-worktree' };
  if (s.worktreeState !== 'ready') return { ok: false, code: 'not-ready' };

  // The merge targets WHATEVER THE PROJECT HAS CHECKED OUT right now, not the
  // branch the session was cut from. `s.baseBranch` stays the fork point (the
  // session's diff reads from it), but "merge" means "land this on the branch I
  // am looking at": cutting a session from main and then moving the project to a
  // release branch means the release branch is where the work is wanted.
  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: M });
  const A = head.ok ? head.stdout.trim() : '';
  if (!A || A === 'HEAD') return { ok: false, code: 'detached-main' };
  const mainStatus = await git(['status', '--porcelain=v1', '--untracked-files=no'], { cwd: M });
  if (mainStatus.ok && mainStatus.stdout.trim()) return { ok: false, code: 'dirty-main' };

  // 1. Commit whatever the session left uncommitted in its own tree. `add -A` is
  //    right here (unlike commit-session's synthesized blobs) precisely because
  //    nothing else writes to this checkout.
  const wtStatus = await git(['status', '--porcelain=v1', '--untracked-files=all'], { cwd: W });
  if (wtStatus.ok && wtStatus.stdout.trim()) {
    const add = await git(['add', '-A'], { cwd: W });
    if (!add.ok) return { ok: false, stderr: add.stderr };
    const patch = await git(['diff', '--cached'], { cwd: W });
    const msg = await sessionCommitMessage(s, id, patch.ok ? patch.stdout : '');
    const commit = await git(['commit', '-m', msg], { cwd: W });
    if (!commit.ok) return { ok: false, stderr: commit.stderr };
  }

  // 2. Nothing ahead of the base means there is nothing to land. Say so plainly
  //    rather than creating an empty merge commit.
  const ahead = await git(['rev-list', '--count', `${A}..${B}`], { cwd: M });
  if (ahead.ok && Number(ahead.stdout.trim()) === 0) return { ok: true, noop: true };

  // 3. Integrate the base INTO the session's branch first, inside the worktree. If
  //    the base moved on, this is where a conflict surfaces — in the session's own
  //    tree, which the user can hand straight to that session's agent. On failure
  //    we abort so the worktree is left clean rather than mid-merge.
  const behind = await git(['rev-list', '--count', `${B}..${A}`], { cwd: M });
  if (behind.ok && Number(behind.stdout.trim()) > 0) {
    const integrate = await git(['merge', '--no-edit', A], { cwd: W });
    if (!integrate.ok) {
      const text = `${integrate.stdout}\n${integrate.stderr}`;
      await git(['merge', '--abort'], { cwd: W });
      if (isMergeConflict(text)) return { ok: false, code: 'conflict', needsMerge: true, stderr: text.trim(), branch: B, base: A };
      return { ok: false, stderr: integrate.stderr };
    }
  }

  // 4. Land it. The base is already an ancestor of the branch after step 3, so
  //    this merge cannot conflict. --no-ff keeps the session as a visible boundary
  //    in history (and makes "was this session merged" a plain ancestry question).
  const label = s.name || B;
  const merge = await git(['merge', '--no-ff', '--no-edit', '-m', `Merge session: ${label} (${B})`, B], { cwd: M });
  if (!merge.ok) {
    const text = `${merge.stdout}\n${merge.stderr}`;
    await git(['merge', '--abort'], { cwd: M });
    if (isMergeConflict(text)) return { ok: false, code: 'conflict', needsMerge: true, stderr: text.trim(), branch: B, base: A };
    return { ok: false, stderr: merge.stderr };
  }

  s.merged = true;
  setSessionState(id, 'pushed'); // the same purple dot a per-session commit leaves
  persistSession(id);
  // The session's diff is now empty relative to the base — tell the client to
  // re-read it so the badge and the Merge button settle.
  sendToRenderer('session-meta', { id, firstPrompt: s.firstPrompt || '', files: [] });
  return { ok: true, branch: B, base: A };
}

bridge.handle('merge-session', guard('merging a session', (_e, id) => repoWrite(() => mergeSession(id)),
  (err) => ({ ok: false, stderr: err && err.message ? err.message : String(err) })));

module.exports = { mergeSession };
