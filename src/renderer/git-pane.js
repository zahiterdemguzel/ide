import { openGitFile, openCommit } from './viewer/center.js';
import { statusLabel } from './shared/git-status.js';
import { t } from '../i18n/index.js';

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
  revert.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  revert.title = 'Discard changes';
  revert.onclick = async (e) => {
    e.stopPropagation();
    if (!revert.classList.contains('armed')) {
      revert.classList.add('armed');
      li.classList.add('warn');
      revert.title = 'Click again to discard — this cannot be undone';
      return;
    }
    const r = await window.api.gitRevert({ file, untracked: status === '?' });
    if (r && !r.ok) showGitErrorDialog(r.stderr || 'Discard failed', 'Discard failed');
    refreshGit();
  };

  const btn = document.createElement('button');
  btn.className = 'git-btn';
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
  const r = await window.api.gitStatus();
  if (r.repo) window.api.setWindowTitle(r.repo);
  stagedEl.innerHTML = '';
  unstagedEl.innerHTML = '';
  conflictsEl.innerHTML = '';
  if (!r.ok) { conflictsSection.hidden = true; return; }
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
  // Conflicted files can't be staged/discarded by the +/− actions; show them in
  // their own section. Staging a resolved file is done after the user (or a Claude
  // session) edits it — it then moves out of conflicts on the next refresh.
  const conflicts = r.conflicts || [];
  conflictsSection.hidden = !conflicts.length;
  for (const it of conflicts) conflictsEl.appendChild(conflictItem(it.file, it.status));
  for (const it of r.staged) stagedEl.appendChild(gitItem(it.file, it.status, true, window.api.gitUnstage, '−'));
  for (const it of r.unstaged) unstagedEl.appendChild(gitItem(it.file, it.status, false, window.api.gitStage, '+'));
}

const conflictsSection = document.getElementById('conflicts-section');
const conflictsEl = document.getElementById('conflicts-list');

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
  btn.className = 'git-btn';
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
    revertAllBtn.title = 'Click again to discard all changes — this cannot be undone';
    return;
  }
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
const REVERT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';

function commitItem(c) {
  const li = document.createElement('li');
  li.className = 'commit-item';
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
  main.append(subject, meta);

  // Two-click revert: first click arms (red), second creates the revert commit.
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.innerHTML = REVERT_SVG;
  revert.title = 'Revert this commit';
  revert.onclick = async (e) => {
    e.stopPropagation();
    if (!revert.classList.contains('armed')) {
      revert.classList.add('armed');
      li.classList.add('warn');
      revert.title = 'Click again to revert this commit';
      return;
    }
    const r = await window.api.gitRevertCommit(c.hash);
    if (!r.ok) showGitErrorDialog(r.stderr || 'Revert failed', 'Revert failed');
    refreshHistory();
    refreshGit();
  };

  li.append(main, revert);
  return li;
}

export async function refreshHistory() {
  const r = await window.api.gitLog();
  historyEl.innerHTML = '';
  if (!r.ok) return;
  for (const c of r.commits) historyEl.appendChild(commitItem(c));
}

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
const commitMsgEl = document.getElementById('commit-msg');
function showGitMsg(text, ok) {
  commitMsgEl.placeholder = text;
  commitMsgEl.classList.remove('msg-ok', 'msg-err');
  commitMsgEl.classList.add(ok ? 'msg-ok' : 'msg-err');
}
function clearGitMsg() {
  commitMsgEl.placeholder = t('git.commitPlaceholder');
  commitMsgEl.classList.remove('msg-ok', 'msg-err');
}
commitMsgEl.addEventListener('focus', clearGitMsg);

function showGitErrorDialog(message, title = 'Push failed') {
  document.getElementById('git-error-title').textContent = title;
  document.getElementById('git-error-msg').textContent = message;
  document.getElementById('git-error-dialog').showModal();
}
document.getElementById('git-error-ok').onclick = () => {
  document.getElementById('git-error-dialog').close();
};

document.getElementById('git-fetch').onclick = async () => {
  const r = await window.api.gitFetch();
  showGitMsg(r.ok ? 'Fetched' : (r.stderr || 'Fetch failed'), r.ok);
  refreshGit();
};
const pullBtn = document.getElementById('git-pull');
pullBtn.onclick = async () => {
  document.getElementById('git-behind').hidden = true;
  pullBtn.classList.add('loading');
  pullBtn.disabled = true;
  const r = await window.api.gitPull();
  pullBtn.classList.remove('loading');
  pullBtn.disabled = false;
  showGitMsg(r.ok ? 'Pulled' : (r.stderr || 'Pull failed'), r.ok);
  refreshGit();
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
  if (!r.ok) showGitErrorDialog(r.stderr || 'Push failed');
  refreshGit();
};
