import { openGitFile, openCommit } from './viewer/center.js';

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
    await window.api.gitRevert({ file, untracked: status === '?' });
    refreshGit();
  };

  const btn = document.createElement('button');
  btn.className = 'git-btn';
  btn.textContent = label;
  btn.onclick = async (e) => { e.stopPropagation(); await action(file); refreshGit(); };

  li.append(st, name, revert, btn);
  return li;
}

export async function refreshGit() {
  const r = await window.api.gitStatus();
  if (r.repo) window.api.setWindowTitle(r.repo);
  stagedEl.innerHTML = '';
  unstagedEl.innerHTML = '';
  if (!r.ok) return;
  const aheadEl = document.getElementById('git-ahead');
  aheadEl.textContent = r.ahead;
  aheadEl.hidden = !r.ahead;
  unstagedFiles = r.unstaged;
  revertAllBtn.classList.remove('armed');
  for (const it of r.staged) stagedEl.appendChild(gitItem(it.file, it.status, true, window.api.gitUnstage, '−'));
  for (const it of r.unstaged) unstagedEl.appendChild(gitItem(it.file, it.status, false, window.api.gitStage, '+'));
}

// "Changes" header buttons: stage / discard every unstaged file at once.
let unstagedFiles = [];
const stageAllBtn = document.getElementById('stage-all');
const revertAllBtn = document.getElementById('revert-all');

stageAllBtn.onclick = async () => {
  for (const it of unstagedFiles) await window.api.gitStage(it.file);
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

// --- commit / undo / push ---
const gitMsgEl = document.getElementById('git-msg');
function showGitMsg(text, ok) {
  gitMsgEl.textContent = text;
  gitMsgEl.className = 'git-msg ' + (ok ? 'ok' : 'err');
}

function showGitErrorDialog(message, title = 'Push failed') {
  document.getElementById('git-error-title').textContent = title;
  document.getElementById('git-error-msg').textContent = message;
  document.getElementById('git-error-dialog').showModal();
}
document.getElementById('git-error-ok').onclick = () => {
  document.getElementById('git-error-dialog').close();
};

document.getElementById('git-refresh').onclick = refreshGit;
document.getElementById('git-fetch').onclick = async () => {
  const r = await window.api.gitFetch();
  showGitMsg(r.ok ? 'Fetched' : (r.stderr || 'Fetch failed'), r.ok);
  refreshGit();
};
document.getElementById('git-pull').onclick = async () => {
  const r = await window.api.gitPull();
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
