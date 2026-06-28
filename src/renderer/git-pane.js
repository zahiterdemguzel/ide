import { openGitFile, openCommit, openStash } from './viewer/center.js';
import { statusLabel } from './shared/git-status.js';
import { showArmHint, hideArmHint } from './shared/arm-hint.js';
import { confirmDialog } from './shared/confirm.js';
import { newSessionWithPrompt, refreshAllDiffStats } from './sessions.js';
import { t } from '../i18n/index.js';

// Offer to hand a git/GitHub problem to a fresh Claude session. Used when a pull or
// push fails because the branch diverged from the remote, and from the Conflicts
// section's "Let Claude resolve" button. It confirms first, then spawns a session
// pre-loaded with one generic merge prompt that covers all three cases — plus the
// exact git error, so the agent knows what actually went wrong without re-deriving it.
async function offerClaudeMerge(title, message, errorText) {
  if (!(await confirmDialog({ title, message, ok: t('git.letClaude') }))) return;
  const err = (errorText || '').trim();
  const prompt = err ? `${t('git.mergePrompt')}\n\n${t('git.mergePromptError')}\n${err}` : t('git.mergePrompt');
  newSessionWithPrompt(prompt);
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

function gitItem(file, status, staged, action, label) {
  const li = document.createElement('li');
  li.onclick = () => openGitFile(file, status, staged);
  const st = document.createElement('span');
  st.className = 'git-status g-' + (status === '?' ? 'u' : status);
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

const conflictsSection = document.getElementById('conflicts-section');
const conflictsEl = document.getElementById('conflicts-list');
document.getElementById('conflicts-resolve').onclick = () =>
  offerClaudeMerge(t('git.conflictsTitle'), t('git.conflictsMsg'));

// A conflicted file: click to view its diff, "+" to mark resolved (git add) once
// the markers are sorted out. No discard here — resolving is a deliberate edit.
function conflictItem(file, status) {
  const li = document.createElement('li');
  li.onclick = () => openGitFile(file, status, false);
  const st = document.createElement('span');
  st.className = 'git-status g-conflict';
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

// rotate-ccw icon (same glyph the discard buttons use)
const REVERT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

function commitItem(c) {
  // Unpushed commits aren't on the remote yet, so they're tagged (green pill +
  // accent stripe, mirroring the green "ahead" push badge) and their button drops
  // the commit from history. Pushed commits can't be safely rewritten, so theirs
  // reverts (a new undo commit) instead.
  const unpushed = !c.pushed;
  const li = document.createElement('li');
  li.className = unpushed ? 'commit-item unpushed' : 'commit-item';
  li.onclick = () => openCommit(c.hash, c.subject);

  const main = document.createElement('div');
  main.className = 'commit-main';
  const subject = document.createElement('div');
  subject.className = 'commit-subject';
  subject.textContent = c.subject;
  subject.title = c.subject;
  const meta = document.createElement('div');
  meta.className = 'commit-meta';
  meta.textContent = `${c.short} · ${c.author} · ${c.relDate}`;
  if (unpushed) {
    const tag = document.createElement('span');
    tag.className = 'commit-tag-unpushed';
    tag.textContent = t('git.unpushed');
    tag.title = t('git.unpushedTitle');
    meta.append(' ', tag);
  }
  main.append(subject, meta);

  // Two-click confirm, same as the file discard buttons: first click arms (red),
  // second runs it — undo (drop) for unpushed, revert (new commit) for pushed.
  const armKey = unpushed ? 'armHint.undoCommit' : 'armHint.revertCommit';
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.innerHTML = REVERT_SVG;
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

  li.append(main, revert);
  return li;
}

// The History tab caches the last log so its search box can re-filter without a
// fresh git call. Matching mirrors main's filterCommits (git-parse.js): every
// whitespace-split term must appear in subject, author, or hash — kept in sync
// with that unit-tested function.
let allCommits = [];
const historySearch = document.getElementById('history-search');

function renderHistory() {
  const terms = historySearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  historyEl.innerHTML = '';
  for (const c of allCommits) {
    const hay = `${c.subject} ${c.author} ${c.hash} ${c.short}`.toLowerCase();
    if (terms.every((term) => hay.includes(term))) historyEl.appendChild(commitItem(c));
  }
}

historySearch.oninput = renderHistory;

export async function refreshHistory() {
  const r = await window.api.gitLog();
  allCommits = r.ok ? r.commits : [];
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

function renderBranchList() {
  const raw = branchSearch.value.trim();
  const q = raw.toLowerCase();
  const matches = allBranches.filter((b) => b.toLowerCase().includes(q));
  branchListEl.innerHTML = '';
  // Offer creation whenever the typed name isn't already an exact branch.
  const canCreate = raw && !allBranches.some((b) => b === raw);
  branchEmptyEl.hidden = matches.length > 0 || canCreate;
  if (canCreate) {
    const li = document.createElement('li');
    li.className = 'branch-item branch-create';
    li.textContent = `${t('git.createBranch')} “${raw}”`;
    li.title = li.textContent;
    li.onclick = () => createBranch(raw);
    branchListEl.appendChild(li);
  }
  for (const b of matches) {
    const li = document.createElement('li');
    li.className = 'branch-item' + (b === currentBranch ? ' current' : '');
    li.textContent = b;
    li.title = b;
    li.onclick = () => switchBranch(b);
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

async function switchBranch(branch) {
  if (branch === currentBranch) { closeBranchMenu(); return; }
  closeBranchMenu();
  const r = await window.api.gitCheckout(branch);
  if (!r.ok) { showGitErrorDialog(r.stderr || 'Checkout failed', 'Checkout failed'); return; }
  refreshGit();
  refreshHistory();
}

async function openBranchMenu() {
  branchMenu.hidden = false;
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
    if (allBranches.includes(raw)) switchBranch(raw); else createBranch(raw);
  }
};
// Dismiss on any click outside the popover (but not the toggle button itself).
document.addEventListener('click', (e) => {
  if (!branchMenu.hidden && !branchMenu.contains(e.target) && e.target !== branchBtn) closeBranchMenu();
});

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
  if (r.needsMerge) offerClaudeMerge(t('git.pullMergeTitle'), t('git.pullMergeMsg'), r.stderr);
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
    if (r.needsMerge) offerClaudeMerge(t('git.pushMergeTitle'), t('git.pushMergeMsg'), r.stderr);
    else showGitErrorDialog(r.stderr || 'Push failed');
  }
  refreshGit();
};
