const { Terminal } = window;
const FitAddon = window.FitAddon.FitAddon;

const sessions = new Map(); // id -> { term, fit, container, li, dot, state }
let activeId = null;

const listEl = document.getElementById('session-list');
const hostEl = document.getElementById('terminal-host');
const emptyHint = document.getElementById('empty-hint');
const repoLabel = document.getElementById('repo-label');

const STATE_LABEL = {
  working: 'Working',
  'needs-input': 'Needs input',
  completed: 'Completed',
  pushed: 'Pushed',
};

function termTheme() {
  return {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  };
}

function setState(id, state) {
  const s = sessions.get(id);
  if (!s) return;
  s.state = state;
  s.dot.className = 'dot ' + state;
  s.dot.title = STATE_LABEL[state] || state;
}

function selectSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  emptyHint.style.display = 'none';
  for (const [, o] of sessions) o.container.style.display = o === s ? 'block' : 'none';
  for (const o of listEl.children) o.classList.toggle('active', o.dataset.id === id);
  fit(s);
  s.term.focus();
}

function fit(s) {
  try {
    s.fit.fit();
    window.api.resize(s.id, s.term.cols, s.term.rows);
  } catch { /* container hidden / closing */ }
}

async function newSession() {
  // probe a size from a temporary fit after open
  const res = await window.api.newSession({ cols: 80, rows: 24 });
  const id = res.id;

  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);

  const term = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  term.onData((data) => window.api.sendInput(id, data));

  const li = document.createElement('li');
  li.dataset.id = id;
  const dot = document.createElement('span');
  dot.className = 'dot working';
  const label = document.createElement('span');
  label.className = 'sess-label';
  label.textContent = 'session ' + id.slice(0, 8);
  const close = document.createElement('button');
  close.className = 'sess-close';
  close.textContent = '×';
  close.onclick = (e) => { e.stopPropagation(); closeSession(id); };
  li.append(dot, label, close);
  li.onclick = () => selectSession(id);
  listEl.appendChild(li);

  sessions.set(id, { id, term, fit: fitAddon, container, li, dot, state: 'working' });
  selectSession(id);
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  window.api.killSession(id);
  s.term.dispose();
  s.container.remove();
  s.li.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = sessions.keys().next();
    if (!next.done) selectSession(next.value);
    else emptyHint.style.display = 'block';
  }
}

// --- git pane ---
function gitItem(file, status, action, label) {
  const li = document.createElement('li');
  const st = document.createElement('span');
  st.className = 'git-status g-' + (status === '?' ? 'u' : status);
  st.textContent = status;
  const name = document.createElement('span');
  name.className = 'git-file';
  name.textContent = file;
  name.title = file;
  const btn = document.createElement('button');
  btn.className = 'git-btn';
  btn.textContent = label;
  btn.onclick = async () => { await action(file); refreshGit(); };
  li.append(st, name, btn);
  return li;
}

async function refreshGit() {
  const r = await window.api.gitStatus();
  const stagedEl = document.getElementById('staged-list');
  const unstagedEl = document.getElementById('unstaged-list');
  stagedEl.innerHTML = '';
  unstagedEl.innerHTML = '';
  if (!r.ok) {
    repoLabel.textContent = (r.repo || '') + '  (not a git repo)';
    return;
  }
  repoLabel.textContent = r.repo || '';
  for (const it of r.staged) stagedEl.appendChild(gitItem(it.file, it.status, window.api.gitUnstage, '−'));
  for (const it of r.unstaged) unstagedEl.appendChild(gitItem(it.file, it.status, window.api.gitStage, '+'));
}

// --- wiring ---
window.api.onPtyData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});
window.api.onStatus(({ id, state }) => setState(id, state));

const gitMsgEl = document.getElementById('git-msg');
function showGitMsg(text, ok) {
  gitMsgEl.textContent = text;
  gitMsgEl.className = 'git-msg ' + (ok ? 'ok' : 'err');
}

document.getElementById('new-session').onclick = newSession;
document.getElementById('git-refresh').onclick = refreshGit;
document.getElementById('git-commit').onclick = async () => {
  const box = document.getElementById('commit-msg');
  const msg = box.value.trim();
  if (!msg) { showGitMsg('Enter a commit message', false); return; }
  const r = await window.api.gitCommit(msg);
  showGitMsg(r.ok ? 'Committed' : (r.stderr || 'Commit failed'), r.ok);
  if (r.ok) box.value = '';
  refreshGit();
};
document.getElementById('git-push').onclick = async () => {
  showGitMsg('Pushing…', true);
  const r = await window.api.gitPush();
  showGitMsg(r.ok ? 'Pushed' : (r.stderr || 'Push failed'), r.ok);
};
document.getElementById('open-folder').onclick = async () => {
  const r = await window.api.openFolder();
  if (!r.canceled) { repoLabel.textContent = r.repo; refreshGit(); }
};

window.addEventListener('resize', () => { if (activeId) fit(sessions.get(activeId)); });

refreshGit();
