console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval git-pane.js'); // PERF-TEMP
import { openGitFile, openCommit, openStash } from './viewer/center.js';
import { statusLabel, normalizeBranchName } from './shared/git-status.js';
import { showArmHint, hideArmHint } from './shared/arm-hint.js';
import { confirmDialog } from './shared/confirm.js';
import { newSessionWithPrompt, refreshAllDiffStats } from './sessions.js';
import { t } from '../i18n/index.js';

// Offer to hand a git/GitHub problem to a fresh Claude session. Used when a pull or
// push fails because the branch diverged from the remote, and from the Conflicts
// section's "Let Claude resolve" button. It confirms first, then spawns a session
// pre-loaded with one generic merge prompt that covers all three cases — plus which
// operation the user was running (`operation`, a translated phrase) and the exact
// git error, so the agent knows both what was being attempted and what went wrong
// without re-deriving either.
async function offerClaudeMerge(title, message, errorText, operation) {
  if (!(await confirmDialog({ title, message, ok: t('git.letClaude') }))) return;
  const err = (errorText || '').trim();
  const parts = [t('git.mergePrompt')];
  if (operation) parts.push(`${t('git.mergePromptOp')} ${operation}`);
  if (err) parts.push(`${t('git.mergePromptError')}\n${err}`);
  newSessionWithPrompt(parts.join('\n\n'));
}

// --- git pane ---
const stagedEl = document.getElementById('staged-list');
const unstagedEl = document.getElementById('unstaged-list');

// Collapse long paths to …trailing/segments that fit within MAX_PATH, keeping whole
// folder/filename segments rather than cutting mid-name. The basename is always kept
// in full unless it alone overflows, in which case its middle is elided (keeping the
// extension). Full path stays in the row's tooltip.
const MAX_PATH = 40;
function shortenPath(file) {
  if (file.length <= MAX_PATH) return file;
  const parts = file.split('/');
  let tail = parts.pop();
  // Basename alone is too long: keep head + extension, elide the middle.
  if (tail.length + 1 > MAX_PATH) {
    const dot = tail.lastIndexOf('.');
    const ext = dot > 0 ? tail.slice(dot) : '';
    const head = tail.slice(0, MAX_PATH - ext.length - 1);
    return head + '…' + ext;
  }
  while (parts.length && ('…' + parts[parts.length - 1] + '/' + tail).length <= MAX_PATH) {
    tail = parts.pop() + '/' + tail;
  }
  return '…' + tail;
}

// Same drag payload as the explorer tree: an "@<rel>" mention on text/plain,
// which the session terminal host's drop handler forwards to the active agent.
function makeFileDraggable(li, file) {
  li.draggable = true;
  li.addEventListener('dragstart', (ev) => {
    ev.dataTransfer.setData('text/plain', '@' + file);
    ev.dataTransfer.effectAllowed = 'copy';
  });
}

function gitItem(file, status, staged, action, label) {
  const li = document.createElement('li');
  makeFileDraggable(li, file);
  // The change-type class drives the one bit of color in the list: the tinted
  // status letter (see .git-status in git.css). Everything else stays neutral.
  li.className = 'g-' + (status === '?' ? 'u' : status);
  li.onclick = () => openGitFile(file, status, staged);
  const st = document.createElement('span');
  st.className = 'git-status';
  st.textContent = status;
  st.title = statusLabel(status, staged);
  const name = document.createElement('span');
  name.className = 'git-file';
  name.textContent = shortenPath(file);
  name.title = file;

  // Two-click discard: first click arms (red), second click reverts.
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  revert.title = 'Discard changes';
  revert.onclick = async (e) => {
    e.stopPropagation();
    if (!revert.classList.contains('armed')) {
      revert.classList.add('armed');
      li.classList.add('warn');
      revert.title = t('armHint.discard');
      showArmHint(revert);
      return;
    }
    hideArmHint();
    const r = await window.api.gitRevert({ file, untracked: status === '?' });
    if (r && !r.ok) showGitErrorDialog(r.stderr || 'Discard failed', 'Discard failed');
    refreshGit();
  };

  const btn = document.createElement('button');
  btn.className = 'git-btn git-glyph';
  btn.textContent = label;
  btn.onclick = async (e) => {
    e.stopPropagation();
    const r = await action(file);
    if (r && !r.ok) showGitErrorDialog(r.stderr || 'Operation failed', label === '+' ? 'Stage failed' : 'Unstage failed');
    refreshGit();
  };

  li.append(st, name, revert, btn);
  return li;
}

export async function refreshGit() {
  // No folder open yet (fresh launch, nothing picked): leave the pane alone —
  // the create-repo panel would make no sense with no folder to init.
  const repoPath = await window.api.getRepoPath();
  if (!repoPath) return;
  // A non-git folder swaps the whole pane for the create-repository panel; bail
  // before any porcelain call (they'd all fail with "not a git repository").
  if (!(await window.api.gitIsRepo())) {
    window.api.setWindowTitle(repoPath);
    showCreatePanel(repoPath);
    return;
  }
  hideCreatePanel();
  refreshStashes(); // independent of working-tree status; runs even when not in a repo
  const r = await window.api.gitStatus();
  if (r.repo) window.api.setWindowTitle(r.repo);
  stagedEl.innerHTML = '';
  unstagedEl.innerHTML = '';
  conflictsEl.innerHTML = '';
  const cleanEl = document.getElementById('git-clean');
  if (!r.ok) { conflictsSection.hidden = true; cleanEl.hidden = true; return; }
  // Nothing staged, unstaged, or conflicted → the working tree is clean; show a
  // reassuring empty state where the file lists would otherwise be.
  cleanEl.hidden = !!(r.staged.length || r.unstaged.length || (r.conflicts || []).length);
  const aheadEl = document.getElementById('git-ahead');
  aheadEl.textContent = r.ahead;
  aheadEl.hidden = !r.ahead;
  const behindEl = document.getElementById('git-behind');
  behindEl.textContent = r.behind;
  behindEl.hidden = !r.behind;
  setBranchName(r.branch);
  unstagedFiles = r.unstaged;
  stagedFiles = r.staged;
  revertAllBtn.classList.remove('armed');
  hideArmHint(); // rows are rebuilt below, dropping any armed button the bubble pointed at
  // Conflicted files can't be staged/discarded by the +/− actions; show them in
  // their own section. Staging a resolved file is done after the user (or a Claude
  // session) edits it — it then moves out of conflicts on the next refresh.
  const conflicts = r.conflicts || [];
  conflictsSection.hidden = !conflicts.length;
  for (const it of conflicts) conflictsEl.appendChild(conflictItem(it.file, it.status));
  for (const it of r.staged) stagedEl.appendChild(gitItem(it.file, it.status, true, window.api.gitUnstage, '−'));
  for (const it of r.unstaged) unstagedEl.appendChild(gitItem(it.file, it.status, false, window.api.gitStage, '+'));
  // When the working-tree state actually changed (a commit moved HEAD, a file was
  // staged/edited on disk), re-validate every session's commit-count — it's
  // computed against HEAD and the poll/focus/commit paths all funnel through here.
  // Gated on a signature so the 3s poll doesn't fan out a diff-per-session when
  // nothing moved.
  const sig = gitStateSignature(r);
  if (sig !== lastGitSig) { lastGitSig = sig; refreshAllDiffStats(); }
}

// A compact fingerprint of the working-tree state: branch + ahead/behind (so a
// commit, which always bumps `ahead`, registers) plus every staged/unstaged/
// conflicted path and its status (so an external edit or stage registers).
let lastGitSig = null;
function gitStateSignature(r) {
  const files = (list) => (list || []).map((it) => it.status + it.file).join(',');
  return [r.branch, r.ahead, r.behind, files(r.staged), files(r.unstaged), files(r.conflicts)].join('|');
}

// Background `git fetch` to refresh the remote-tracking refs — and so the
// ahead/behind badges — without blocking the UI. Fired on startup, on opening
// another folder, and on switching branches. It's a convenience, not a
// user-requested action, so a failure (no remote, offline, non-git folder) is
// swallowed; only a successful fetch re-renders, surfacing a freshly discovered
// "behind" count right away.
export async function autoFetch() {
  try {
    const r = await window.api.gitFetch();
    // A successful fetch can surface newly incoming commits; refresh the History
    // view too when it's open so its preview reflects them right away.
    if (r && r.ok) { refreshGit(); if (!historyView.hidden) refreshHistory(); }
  } catch {}
}

const conflictsSection = document.getElementById('conflicts-section');
const conflictsEl = document.getElementById('conflicts-list');
document.getElementById('conflicts-resolve').onclick = () =>
  offerClaudeMerge(t('git.conflictsTitle'), t('git.conflictsMsg'), null, t('git.opResolve'));

// A conflicted file: click to view its diff, "+" to mark resolved (git add) once
// the markers are sorted out. No discard here — resolving is a deliberate edit.
function conflictItem(file, status) {
  const li = document.createElement('li');
  makeFileDraggable(li, file);
  li.className = 'g-conflict';
  li.onclick = () => openGitFile(file, status, false);
  const st = document.createElement('span');
  st.className = 'git-status';
  st.textContent = '!';
  st.title = 'Conflict (' + status + ')';
  const name = document.createElement('span');
  name.className = 'git-file';
  name.textContent = shortenPath(file);
  name.title = file;
  const btn = document.createElement('button');
  btn.className = 'git-btn git-glyph';
  btn.textContent = '✓';
  btn.title = 'Mark resolved (stage)';
  btn.onclick = async (e) => {
    e.stopPropagation();
    const r = await window.api.gitStage(file);
    if (r && !r.ok) showGitErrorDialog(r.stderr || 'Stage failed', 'Resolve failed');
    refreshGit();
  };
  li.append(st, name, btn);
  return li;
}

// "Changes" header buttons: stage / discard every unstaged file at once.
let unstagedFiles = [];
let stagedFiles = [];
const stageAllBtn = document.getElementById('stage-all');
const revertAllBtn = document.getElementById('revert-all');
const unstageAllBtn = document.getElementById('unstage-all');

stageAllBtn.onclick = async () => {
  for (const it of unstagedFiles) await window.api.gitStage(it.file);
  refreshGit();};
unstageAllBtn.onclick = async () => {
  for (const it of stagedFiles) await window.api.gitUnstage(it.file);
  refreshGit();};
revertAllBtn.onclick = async () => {
  if (!revertAllBtn.classList.contains('armed')) {
    revertAllBtn.classList.add('armed');
    document.querySelectorAll('#unstaged-list li').forEach(li => li.classList.add('warn'));
    revertAllBtn.title = t('armHint.discardAll');
    showArmHint(revertAllBtn);
    return;
  }
  hideArmHint();
  for (const it of unstagedFiles) await window.api.gitRevert({ file: it.file, untracked: it.status === '?' });
  refreshGit();};

// --- tabs: Changes / History ---
const gitTabs = document.getElementById('git-tabs');
const changesView = document.getElementById('git-changes-view');
const historyView = document.getElementById('git-history-view');
const historyEl = document.getElementById('history-list');

gitTabs.querySelectorAll('.git-tab').forEach((tab) => {
  tab.onclick = () => {
    gitTabs.querySelectorAll('.git-tab').forEach((t) => t.classList.toggle('active', t === tab));
    const history = tab.dataset.tab === 'history';
    changesView.hidden = history;
    historyView.hidden = !history;
    if (history) refreshHistory();
  };
});

// rotate-ccw icon (same glyph the discard buttons use), for reverting pushed commits
const REVERT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
// undo-2 icon (straight-then-curve arrow) — distinct from REVERT_SVG so dropping an
// unpushed commit doesn't look identical to reverting a pushed one.
const UNDO_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
// Lucide `upload` / `download` — the leading direction icon on a history row: an
// unpushed (outgoing) commit is going up to the remote, an incoming one is coming
// down on the next pull. Colour-matched to the row's left stripe via .commit-dir.
const UPLOAD_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';
const DOWNLOAD_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>';

function commitItem(c) {
  // A commit's direction drives both its look and its action. A leading direction
  // icon (download = incoming, upload = unpushed) sits left of the subject, colour-
  // matched to the row's left stripe; pushed commits get an empty slot so subjects
  // stay aligned.
  // • incoming — on the upstream but not yet local; a pull will bring it in. NO action
  //   button (it isn't in our history yet) — clicking the row previews its diff.
  // • unpushed — local, not on the remote yet; its button DROPS it from history.
  // • pushed — on the remote; can't be safely rewritten, so its button REVERTS it
  //   (a new undo commit on top) instead.
  const li = document.createElement('li');
  li.onclick = () => openCommit(c.hash, c.subject);

  const dir = document.createElement('span');
  dir.className = 'commit-dir';

  const main = document.createElement('div');
  main.className = 'commit-main';
  const subject = document.createElement('div');
  subject.className = 'commit-subject';
  subject.textContent = c.subject;
  subject.title = c.subject;
  const meta = document.createElement('div');
  meta.className = 'commit-meta';
  meta.textContent = `${c.short} · ${c.author} · ${c.relDate}`;
  main.append(subject, meta);

  if (c.incoming) {
    li.className = 'commit-item incoming';
    dir.classList.add('incoming');
    dir.innerHTML = DOWNLOAD_SVG;
    dir.title = t('git.incomingTitle');
    li.append(dir, main); // no action — the commit isn't in local history yet
    return li;
  }

  const unpushed = !c.pushed;
  li.className = unpushed ? 'commit-item unpushed' : 'commit-item';
  if (unpushed) {
    dir.classList.add('unpushed');
    dir.innerHTML = UPLOAD_SVG;
    dir.title = t('git.unpushedTitle');
  }

  // Two-click confirm, same as the file discard buttons: first click arms (red),
  // second runs it — undo (drop) for unpushed, revert (new commit) for pushed.
  const armKey = unpushed ? 'armHint.undoCommit' : 'armHint.revertCommit';
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.innerHTML = unpushed ? UNDO_SVG : REVERT_SVG;
  revert.title = unpushed ? t('git.undoCommitTitle') : t('git.revertCommitTitle');
  revert.onclick = async (e) => {
    e.stopPropagation();
    if (!revert.classList.contains('armed')) {
      revert.classList.add('armed');
      li.classList.add('warn');
      revert.title = t(armKey);
      showArmHint(revert);
      return;
    }
    hideArmHint();
    const r = unpushed ? await window.api.gitUndoCommit(c.hash) : await window.api.gitRevertCommit(c.hash);
    if (!r.ok) {
      const title = unpushed ? 'Undo failed' : 'Revert failed';
      showGitErrorDialog(r.stderr || title, title);
    }
    refreshHistory();
    refreshGit();
  };

  li.append(dir, main, revert);
  return li;
}

// The History tab caches the last log so its search box can re-filter without a
// fresh git call. Matching mirrors main's filterCommits (git-parse.js): every
// whitespace-split term must appear in subject, author, or hash — kept in sync
// with that unit-tested function.
let allCommits = [];
let incomingCommits = [];
const historySearch = document.getElementById('history-search');

function renderHistory() {
  const terms = historySearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (c) => {
    const hay = `${c.subject} ${c.author} ${c.hash} ${c.short}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  };
  historyEl.innerHTML = '';
  // Incoming commits (what a pull will bring in) sit above the local log so the
  // user can preview them — and their diffs — before syncing.
  for (const c of incomingCommits) if (matches(c)) historyEl.appendChild(commitItem(c));
  for (const c of allCommits) if (matches(c)) historyEl.appendChild(commitItem(c));
}

historySearch.oninput = renderHistory;

export async function refreshHistory() {
  const r = await window.api.gitLog();
  allCommits = r.ok ? r.commits : [];
  incomingCommits = r.ok ? (r.incoming || []) : [];
  renderHistory();
}

// --- stashes (a section in the Changes view, shown only when stashes exist,
// mirroring the Conflicts section) ---
const stashesSection = document.getElementById('stashes-section');
const stashListEl = document.getElementById('stash-list');

// copy icon — apply a stash but keep it in the list
const STASH_APPLY_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
// download icon — pop a stash (apply it, then drop it)
const STASH_POP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>';
// trash icon — drop a stash (delete it without applying). Stroke is bumped to 3
// (via the .git-revert rule) so it reads boldly at the 14px row size.
const STASH_DROP_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

// Run a stash op (apply/pop/drop), surface any git error, then refresh the pane —
// each op changes either the working tree or the stash list, so a full refresh
// re-renders the section and the file lists together.
async function runStash(op, errTitle) {
  const r = await op();
  if (r && !r.ok) showGitErrorDialog(r.stderr || errTitle, errTitle);
  refreshGit();
}

function stashItem(s) {
  // Reuses the commit-row layout (.commit-main / subject / meta) since a stash
  // reads the same way: a message line over a muted ref · date meta line.
  const li = document.createElement('li');
  li.className = 'stash-item';
  li.onclick = () => openStash(s.ref, s.message);

  const main = document.createElement('div');
  main.className = 'commit-main';
  const subject = document.createElement('div');
  subject.className = 'commit-subject';
  subject.textContent = s.message;
  subject.title = s.message;
  const meta = document.createElement('div');
  meta.className = 'commit-meta';
  meta.textContent = `${s.ref} · ${s.relDate}`;
  main.append(subject, meta);

  const apply = document.createElement('button');
  apply.className = 'git-btn stash-act';
  apply.innerHTML = STASH_APPLY_SVG;
  apply.title = t('git.stashApplyTitle');
  apply.onclick = (e) => { e.stopPropagation(); runStash(() => window.api.gitStashApply(s.ref), 'Apply failed'); };

  const pop = document.createElement('button');
  pop.className = 'git-btn stash-act';
  pop.innerHTML = STASH_POP_SVG;
  pop.title = t('git.stashPopTitle');
  pop.onclick = (e) => { e.stopPropagation(); runStash(() => window.api.gitStashPop(s.ref), 'Pop failed'); };

  // Dropping a stash is destructive and unrecoverable, so it keeps the same
  // two-click armed pattern as the discard buttons (the .git-revert class drives
  // the armed-red styling), but shows a trash icon since it deletes rather than reverts.
  const drop = document.createElement('button');
  drop.className = 'git-btn git-revert';
  drop.innerHTML = STASH_DROP_SVG;
  drop.title = t('git.stashDropTitle');
  drop.onclick = (e) => {
    e.stopPropagation();
    if (!drop.classList.contains('armed')) {
      drop.classList.add('armed');
      li.classList.add('warn');
      drop.title = t('armHint.dropStash');
      showArmHint(drop);
      return;
    }
    hideArmHint();
    runStash(() => window.api.gitStashDrop(s.ref), 'Drop failed');
  };

  li.append(main, apply, pop, drop);
  return li;
}

// Re-render the stash rows only when the set actually changed. The poll/focus
// paths call this every few seconds; rebuilding the DOM each time would wipe a
// hovered row's effects and disarm a half-clicked Drop button. The signature is
// the stash identities (ref + message) — NOT the relative date, so a cosmetic
// "2 hours ago" → "3 hours ago" tick doesn't force a pointless redraw.
let lastStashSig = null;
async function refreshStashes() {
  const r = await window.api.gitStashList();
  const stashes = r.ok ? r.stashes : [];
  const sig = stashes.map((s) => s.ref + '\x1f' + s.message).join('\n');
  if (sig === lastStashSig) return;
  lastStashSig = sig;
  stashListEl.innerHTML = '';
  stashesSection.hidden = !stashes.length;
  for (const s of stashes) stashListEl.appendChild(stashItem(s));
}

// "Stash" button in the Changes header: set the whole working tree aside.
document.getElementById('git-stash-create').onclick = async () => {
  const r = await window.api.gitStashPush();
  const noChanges = /no local changes/i.test((r.stdout || '') + (r.stderr || ''));
  showGitMsg(r.ok ? (noChanges ? 'Nothing to stash' : 'Changes stashed') : (r.stderr || 'Stash failed'), r.ok && !noChanges);
  refreshGit();
};

// --- branch selector ---
// The header shows the current branch; clicking it opens a searchable popover of
// local branches (there may be many — the list scrolls, the search narrows). The
// list is fetched fresh each time it opens so newly created branches show up.
// The search box doubles as a create field: typing a name that matches no existing
// branch reveals a "Create branch" row that branches off the current HEAD.
const branchBtn = document.getElementById('git-branch');
const branchNameEl = document.getElementById('git-branch-name');
const branchMenu = document.getElementById('branch-menu');
const branchSearch = document.getElementById('branch-search');
const branchListEl = document.getElementById('branch-list');
const branchEmptyEl = document.getElementById('branch-empty');
let allBranches = [];
let currentBranch = '';

function setBranchName(branch) {
  currentBranch = branch || '';
  branchNameEl.textContent = currentBranch || '—';
  branchBtn.title = currentBranch ? `On ${currentBranch} — click to switch` : 'Switch branch';
}

// A remote-only branch is checked out by its short name (the part after the
// remote, e.g. `origin/feature/x` → `feature/x`) so git's DWIM creates a local
// tracking branch instead of detaching HEAD at the remote ref.
function branchCheckoutName(b) {
  return b.remote ? b.name.slice(b.name.indexOf('/') + 1) : b.name;
}

function renderBranchList() {
  const raw = branchSearch.value.trim();
  const q = raw.toLowerCase();
  const matches = allBranches.filter((b) => b.name.toLowerCase().includes(q));
  branchListEl.innerHTML = '';
  // Offer creation whenever the typed name (after turning spaces into hyphens)
  // isn't already an exact branch. The row shows the normalized name so the
  // user sees exactly what will be created.
  const newName = normalizeBranchName(raw);
  const canCreate = newName && !allBranches.some((b) => b.name === newName);
  branchEmptyEl.hidden = matches.length > 0 || canCreate;
  if (canCreate) {
    const li = document.createElement('li');
    li.className = 'branch-item branch-create';
    li.textContent = `${t('git.createBranch')} “${newName}”`;
    li.title = li.textContent;
    li.onclick = () => createBranch(newName);
    branchListEl.appendChild(li);
  }
  for (const b of matches) {
    const li = document.createElement('li');
    const isCurrent = b.name === currentBranch;
    li.className = 'branch-item' + (isCurrent ? ' current' : '') + (b.remote ? ' remote' : '');
    const name = document.createElement('span');
    name.className = 'branch-name';
    name.textContent = b.name;
    name.title = b.remote ? `${b.name} — checkout creates local ${branchCheckoutName(b)}` : b.name;
    li.appendChild(name);
    li.onclick = () => switchBranch(b);
    // The checked-out branch can't be deleted (git refuses) and a remote-tracking
    // branch isn't ours to delete locally, so only the other local rows get a
    // trash button. Deleting a branch is destructive, so it uses the same
    // two-click arm-then-confirm as the stash-drop / discard buttons.
    if (!isCurrent && !b.remote) {
      const del = document.createElement('button');
      del.className = 'git-btn git-revert branch-del';
      del.innerHTML = STASH_DROP_SVG;
      del.title = t('git.deleteBranchTitle');
      del.onclick = (e) => {
        e.stopPropagation();
        if (!del.classList.contains('armed')) {
          del.classList.add('armed');
          del.title = t('armHint.deleteBranch');
          showArmHint(del);
          return;
        }
        hideArmHint();
        deleteBranch(b.name);
      };
      li.appendChild(del);
    }
    branchListEl.appendChild(li);
  }
}

async function createBranch(branch) {
  closeBranchMenu();
  const r = await window.api.gitCreateBranch(branch);
  if (!r.ok) { showGitErrorDialog(r.stderr || 'Create branch failed', 'Create branch failed'); return; }
  refreshGit();
  refreshHistory();
}

async function deleteBranch(branch) {
  const r = await window.api.gitDeleteBranch(branch);
  if (!r.ok) { showGitErrorDialog(r.stderr || 'Delete branch failed', 'Delete branch failed'); return; }
  // Keep the menu open so several branches can be removed in a row; re-fetch so
  // the deleted branch drops out of the list and re-render with the same filter.
  const list = await window.api.gitBranches();
  if (list.ok) { allBranches = list.branches; currentBranch = list.current; }
  renderBranchList();
  refreshGit();
}

async function switchBranch(b) {
  const target = branchCheckoutName(b);
  if (target === currentBranch) { closeBranchMenu(); return; }
  closeBranchMenu();
  const r = await window.api.gitCheckout(target);
  if (!r.ok) { showGitErrorDialog(r.stderr || 'Checkout failed', 'Checkout failed'); return; }
  refreshGit();
  refreshHistory();
  autoFetch();
}

// The menu is position:fixed (so the pane's overflow:hidden can't clip it), so
// JS places it: right edge aligned just inside the git pane's right edge, top
// just below the branch button. It then grows leftward over the terminal area.
function positionBranchMenu() {
  const pane = document.getElementById('git').getBoundingClientRect();
  const btn = branchBtn.getBoundingClientRect();
  branchMenu.style.top = `${Math.round(btn.bottom + 6)}px`;
  branchMenu.style.right = `${Math.round(window.innerWidth - pane.right + 8)}px`;
  branchMenu.style.left = 'auto';
}

async function openBranchMenu() {
  branchMenu.hidden = false;
  positionBranchMenu();
  branchSearch.value = '';
  branchListEl.innerHTML = '';
  branchEmptyEl.hidden = true;
  branchSearch.focus();
  const r = await window.api.gitBranches();
  if (!r.ok) { allBranches = []; } else { allBranches = r.branches; currentBranch = r.current; }
  renderBranchList();
}

function closeBranchMenu() { branchMenu.hidden = true; }

branchBtn.onclick = (e) => {
  e.stopPropagation();
  if (branchMenu.hidden) openBranchMenu(); else closeBranchMenu();
};
branchSearch.oninput = renderBranchList;
branchSearch.onkeydown = (e) => {
  if (e.key === 'Escape') { closeBranchMenu(); branchBtn.focus(); return; }
  if (e.key === 'Enter') {
    const raw = branchSearch.value.trim();
    if (!raw) return;
    const exact = allBranches.find((b) => b.name === raw);
    if (exact) { switchBranch(exact); return; }
    const newName = normalizeBranchName(raw);
    const norm = allBranches.find((b) => b.name === newName);
    if (norm) switchBranch(norm); else createBranch(newName);
  }
};
// Dismiss on any click outside the popover (but not the toggle button itself).
document.addEventListener('click', (e) => {
  if (!branchMenu.hidden && !branchMenu.contains(e.target) && e.target !== branchBtn) closeBranchMenu();
});
// A window/pane resize moves the pane's right edge; keep the open menu aligned to it.
window.addEventListener('resize', () => { if (!branchMenu.hidden) positionBranchMenu(); });

// --- commit / undo / push ---
// Git status feedback (Fetched / Committed / errors…) is surfaced as the commit
// box's placeholder so it sits where the user is already looking, without taking
// up its own row. It only shows while the box is empty; the default placeholder
// returns as soon as the user focuses the box to type.
const statusLineEl = document.getElementById('git-status-line');
let gitMsgTimer = null;
function showGitMsg(text, ok) {
  statusLineEl.textContent = text;
  statusLineEl.classList.toggle('ok', ok);
  statusLineEl.classList.toggle('err', !ok);
  statusLineEl.hidden = false;
  // Feedback shouldn't linger forever — clear a stale "Committed" / error after 7s.
  if (gitMsgTimer) clearTimeout(gitMsgTimer);
  gitMsgTimer = setTimeout(clearGitMsg, 7000);
}
function clearGitMsg() {
  if (gitMsgTimer) { clearTimeout(gitMsgTimer); gitMsgTimer = null; }
  statusLineEl.textContent = '';
  statusLineEl.hidden = true;
  statusLineEl.classList.remove('ok', 'err');
}

function showGitErrorDialog(message, title = 'Push failed') {
  document.getElementById('git-error-title').textContent = title;
  document.getElementById('git-error-msg').textContent = message;
  document.getElementById('git-error-dialog').showModal();
}
document.getElementById('git-error-ok').onclick = () => {
  document.getElementById('git-error-dialog').close();
};

// Sync folds the old Fetch + Pull into one action: fetch to refresh the
// ahead/behind counts, then pull to fast-forward/merge the remote in.
const syncBtn = document.getElementById('git-sync');
syncBtn.onclick = async () => {
  document.getElementById('git-behind').hidden = true;
  syncBtn.classList.add('loading');
  syncBtn.disabled = true;
  await window.api.gitFetch();
  const r = await window.api.gitPull();
  syncBtn.classList.remove('loading');
  syncBtn.disabled = false;
  showGitMsg(r.ok ? 'Synced' : (r.stderr || 'Sync failed'), r.ok);
  refreshGit();
  // The pull moved incoming commits into local history; keep the History preview in sync.
  if (!historyView.hidden) refreshHistory();
  if (r.needsMerge) offerClaudeMerge(t('git.pullMergeTitle'), t('git.pullMergeMsg'), r.stderr, t('git.opPull'));
};
const commitBtn = document.getElementById('git-commit');
commitBtn.onclick = async () => {
  const box = document.getElementById('commit-msg');
  const msg = box.value.trim();
  // Empty message: main authors one from the staged diff via Haiku, which adds
  // latency — disable the button and show progress until it resolves.
  commitBtn.disabled = true;
  if (!msg) showGitMsg('Writing commit message…', true);
  const r = await window.api.gitCommit(msg);
  commitBtn.disabled = false;
  if (r.ok) {
    box.value = '';
    box.dispatchEvent(new Event('input'));
    showGitMsg(msg ? 'Committed' : 'Committed: ' + (r.message || '').split('\n')[0], true);
  } else {
    showGitMsg(r.stderr || 'Commit failed', false);
  }
  refreshGit(); refreshHistory();};
document.getElementById('git-undo').onclick = async () => {
  const r = await window.api.gitUndo();
  showGitMsg(r.ok ? 'Last commit undone' : (r.stderr || 'Undo failed'), r.ok);
  refreshGit(); refreshHistory();};
const pushBtn = document.getElementById('git-push');
pushBtn.onclick = async () => {
  const aheadEl = document.getElementById('git-ahead');
  aheadEl.hidden = true;
  pushBtn.classList.add('loading');
  pushBtn.disabled = true;
  const r = await window.api.gitPush();
  pushBtn.classList.remove('loading');
  pushBtn.disabled = false;
  // A rejection because the remote moved on is fixable by a pull/merge/push, so
  // offer to hand it to Claude rather than just reporting the wall of git text.
  if (!r.ok) {
    if (r.needsMerge) offerClaudeMerge(t('git.pushMergeTitle'), t('git.pushMergeMsg'), r.stderr, t('git.opPush'));
    else showGitErrorDialog(r.stderr || 'Push failed');
  }
  refreshGit();
};

// --- create-repository panel (shown when the open folder isn't a git repo) ---
// Init the repo, make the initial commit, and create + push a GitHub repo, all
// behind one button. The normal Changes/History UI and the branch/sync header
// buttons are hidden while this is up.
const createPanel = document.getElementById('git-create-repo');
const createNameInput = document.getElementById('create-repo-name');
const createDescInput = document.getElementById('create-repo-desc');
const createBtn = document.getElementById('create-repo-btn');
const createMsgEl = document.getElementById('create-repo-msg');
const visibilityEl = document.getElementById('create-repo-visibility');
const gitSyncBtn = document.getElementById('git-sync');
let createVisibility = 'private';

function basename(p) {
  const parts = (p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function showCreatePanel(repoPath) {
  // Prefill the name from the folder the first time the panel opens for it, but
  // never clobber what the user is typing.
  if (createPanel.dataset.path !== repoPath) {
    createPanel.dataset.path = repoPath;
    createNameInput.value = basename(repoPath);
  }
  createPanel.hidden = false;
  gitTabs.hidden = true;
  changesView.hidden = true;
  historyView.hidden = true;
  branchBtn.hidden = true;
  gitSyncBtn.hidden = true;
}

function hideCreatePanel() {
  if (createPanel.hidden) return;
  createPanel.hidden = true;
  delete createPanel.dataset.path;
  gitTabs.hidden = false;
  branchBtn.hidden = false;
  gitSyncBtn.hidden = false;
  // Restore whichever tab was active (changesView is the default).
  const onHistory = gitTabs.querySelector('.git-tab.active')?.dataset.tab === 'history';
  changesView.hidden = onHistory;
  historyView.hidden = !onHistory;
}

function showCreateMsg(text, ok) {
  createMsgEl.textContent = text;
  createMsgEl.classList.toggle('ok', ok);
  createMsgEl.classList.toggle('err', !ok);
  createMsgEl.hidden = false;
}

visibilityEl.querySelectorAll('.git-create-vis').forEach((btn) => {
  btn.onclick = () => {
    createVisibility = btn.dataset.vis;
    visibilityEl.querySelectorAll('.git-create-vis').forEach((b) => b.classList.toggle('active', b === btn));
  };
});

createBtn.onclick = async () => {
  const name = createNameInput.value.trim();
  if (!name) { showCreateMsg(t('git.create.nameRequired'), false); createNameInput.focus(); return; }
  createBtn.disabled = true;
  showCreateMsg(t('git.create.working'), true);
  const r = await window.api.createRepo({ name, description: createDescInput.value.trim(), isPrivate: createVisibility === 'private' });
  createBtn.disabled = false;
  if (r.ok) {
    refreshGit();
    refreshHistory();
  } else {
    showCreateMsg(r.error || t('git.create.failed'), false);
  }
};
