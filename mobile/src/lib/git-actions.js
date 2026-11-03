// Pure decisions behind the phone's Git tab: which actions a commit offers, how a
// git/gh reply reads as a toast, and the name massaging the desktop also does.
// Plain JS so the repo's node:test suite can import it — see
// test/mobile-git-actions.test.mjs. The rules mirror src/renderer/git-pane.js.

/**
 * @typedef {{ ok?: boolean, stdout?: string, stderr?: string, url?: string, existing?: boolean, clean?: boolean }} GitReply
 * @typedef {{ incoming?: boolean, pushed?: boolean }} CommitState
 */

// Git branch names can't contain spaces; turn each run into a hyphen rather than
// rejecting the name. Mirrors normalizeBranchName in src/renderer/shared/git-status.js.
export function normalizeBranchName(name) {
  return String(name || '').trim().replace(/\s+/g, '-');
}

// A remote-only branch is checked out by its short name (`origin/feat` → `feat`) so
// git's DWIM creates a local tracking branch instead of detaching HEAD at the remote ref.
export function checkoutName(branch) {
  return branch.remote ? branch.name.slice(branch.name.indexOf('/') + 1) : branch.name;
}

// The first http(s) URL in gh's output — `gh pr create` prints the new PR's URL, and
// `gh browse` / `gh pr view --web` say "Opening <url> in your browser". Same rule as
// firstUrl in src/main/git-parse.js (trailing punctuation is not part of the URL).
export function firstUrl(text) {
  const m = /https?:\/\/\S+/.exec(text || '');
  return m ? m[0].replace(/[).,]+$/, '') : '';
}

// What a gh reply links to, wherever gh put it: an explicit `url` field, else the
// first URL in stdout or stderr.
export function replyUrl(reply) {
  if (!reply) return '';
  return reply.url || firstUrl(reply.stdout) || firstUrl(reply.stderr);
}

// Which per-commit actions a History row offers, in menu order — the desktop's
// commit context menu (showCommitCtx). An incoming commit isn't in our history yet,
// so it can only be cherry-picked; a pushed one can't be undone (that would rewrite
// remote history), only reverted.
/** @param {CommitState} commit */
export function commitActionKeys(commit) {
  if (commit.incoming) return ['view', 'cherry-pick', 'browse'];
  return [
    'view', 'branch', 'tag', 'browse',
    'revert', ...(commit.pushed ? [] : ['undo']), 'reset-soft', 'reset-hard',
  ];
}

// The quick action a History row carries beside its menu: undo while the commit is
// still local, revert once it's pushed, nothing for an incoming one.
/** @param {CommitState} commit */
export function quickCommitAction(commit) {
  if (commit.incoming) return null;
  return commit.pushed ? 'revert' : 'undo';
}

// git stash push exits 0 with "No local changes to save" when there's nothing to
// stash — the desktop reads that to say so instead of a misleading "stashed".
/** @param {GitReply} reply */
export function stashPushOutcome(reply) {
  if (!reply || reply.ok === false) return 'failed';
  return /no local changes/i.test(`${reply.stdout || ''}${reply.stderr || ''}`) ? 'nothing' : 'stashed';
}

// The toast after a successful pull or push. git says when there was nothing to do
// (pull on stdout, push on stderr), and "Pushed" after a no-op would be a lie.
/** @param {'pull' | 'push'} kind @param {GitReply} reply */
export function syncSuccessMessage(kind, reply) {
  const out = `${reply?.stdout || ''}\n${reply?.stderr || ''}`;
  if (kind === 'pull') return /already up[ -]to[ -]date/i.test(out) ? 'Already up to date' : 'Pulled';
  return /everything up[ -]to[ -]date/i.test(out) ? 'Nothing to push' : 'Pushed';
}

// gh-pr-create always opens the PR in the *desktop's* browser (gh does it itself);
// the toast says so, since the phone user isn't looking at that screen.
/** @param {GitReply} reply */
export function prCreateMessage(reply) {
  return reply?.existing
    ? 'Pull request already open — shown in the desktop browser'
    : 'Pull request created — opened in the desktop browser';
}
