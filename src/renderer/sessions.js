import { Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme } from './shared/terminal.js';
import { hideAllOverlays } from './viewer/center.js';
import { registerTerminalLinks } from './terminal-links.js';
import { refreshGit } from './git-pane.js';

// Each session owns its own xterm.js Terminal in a hidden container div;
// switching sessions toggles which container is visible, preserving scrollback.
const sessions = new Map(); // id -> { id, term, fit, container, li, dot, label, state, firstPrompt, name, files, archived }
let activeId = null;
export const getActiveId = () => activeId;

// Which sessions the list shows: 'active' (default) hides archived, 'archived'
// shows only archived, 'all' shows everything.
let currentTab = 'active';

const listEl = document.getElementById('session-list');
const sessionTabs = document.getElementById('session-tabs');
const hostEl = document.getElementById('terminal-host');
const emptyHint = document.getElementById('empty-hint');
const sessionBar = document.getElementById('session-bar');
const sessionTitle = document.getElementById('session-title');
const sessionCommitBtn = document.getElementById('session-commit');
const sessionRevertBtn = document.getElementById('session-revert');
const sessionCommitMsg = document.getElementById('session-commit-msg');

const STATE_LABEL = {
  working: 'Working',
  'needs-input': 'Needs input',
  completed: 'Completed',
  pushed: 'Committed / pushed',
};

function setState(id, state) {
  const s = sessions.get(id);
  if (!s) return;
  s.state = state;
  s.dot.className = 'dot ' + state;
  s.dot.title = STATE_LABEL[state] || state;
}

export function selectSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  hideAllOverlays();
  emptyHint.style.display = 'none';
  for (const [, o] of sessions) o.container.style.display = o === s ? 'block' : 'none';
  for (const o of listEl.children) o.classList.toggle('active', o.dataset.id === id);
  updateSessionBar();
  fit(s);
  // A hidden xterm can't render its viewport; on reveal it keeps a stale scroll
  // position until new output forces a refresh. Snap to the bottom so the latest
  // output is visible immediately rather than only after the first keystroke.
  // The reveal + fit only take effect on the next frame, so snap there too —
  // a synchronous scrollToBottom here runs against the still-stale viewport.
  s.term.scrollToBottom();
  requestAnimationFrame(() => s.term.scrollToBottom());
  s.term.focus();
}

function sessionInTab(s) {
  if (currentTab === 'all') return true;
  if (currentTab === 'archived') return s.archived;
  return !s.archived; // 'active'
}

// Show/hide rows for the current tab and keep each row's archived styling/title
// in sync with its state.
function applyTabFilter() {
  for (const [, s] of sessions) {
    s.li.style.display = sessionInTab(s) ? '' : 'none';
    s.li.classList.toggle('archived', s.archived);
    s.closeBtn.title = s.archived ? 'Close session permanently' : 'Archive session';
  }
}

// When the selected session leaves the current tab (archived/restored/closed),
// fall back to the first still-visible row, or the empty hint if none remain.
function selectFirstVisible() {
  for (const o of listEl.children) {
    if (o.style.display !== 'none') { selectSession(o.dataset.id); return; }
  }
  activeId = null;
  for (const [, o] of sessions) o.container.style.display = 'none';
  emptyHint.style.display = 'block';
  updateSessionBar();
}

function setTab(tab) {
  currentTab = tab;
  for (const btn of sessionTabs.children) btn.classList.toggle('active', btn.dataset.tab === tab);
  applyTabFilter();
  // The selected session may not belong to the new tab anymore.
  const s = sessions.get(activeId);
  if (!s || !sessionInTab(s)) selectFirstVisible();
}

function setArchived(id, archived) {
  const s = sessions.get(id);
  if (!s) return;
  s.archived = archived;
  applyTabFilter();
  if (activeId === id && !sessionInTab(s)) selectFirstVisible();
}

// Closing an overlay returns here: show the active session if there is one.
export function showActiveSession() {
  if (!activeId) return false;
  selectSession(activeId);
  return true;
}

// Top toolbar: active session's name (its first prompt) + scoped-commit button.
function updateSessionBar() {
  const s = sessions.get(activeId);
  if (!s) { sessionBar.style.display = 'none'; return; }
  sessionBar.style.display = 'flex';
  sessionRevertBtn.classList.remove('armed');
  sessionRevertBtn.textContent = 'Revert';
  const name = s.name || (s.firstPrompt && s.firstPrompt.split('\n')[0]) || ('session ' + s.id.slice(0, 8));
  sessionTitle.textContent = name;
  sessionTitle.title = name;
  // The button itself reports commit state, driven purely by the session's
  // tracked-file list: live "Commit N files" while edits remain, disabled
  // "Nothing to commit" once empty. A successful commit forgets those files
  // (main re-pushes session-meta), so the same button works repeatedly across a
  // session — it re-enables as soon as the session edits again.
  const n = s.files.length;
  sessionCommitBtn.disabled = n === 0;
  sessionCommitBtn.textContent = n ? `Commit ${n} file${n > 1 ? 's' : ''}` : 'Nothing to commit';
  // The notice is now only for failures / revert results, kept per-session so
  // switching sessions never carries a stale message over from another.
  sessionCommitMsg.textContent = s.commitMsg || '';
  sessionCommitMsg.className = 'git-msg ' + (s.commitMsgClass || '');
}

export function fit(s) {
  try {
    s.fit.fit();
    window.api.resize(s.id, s.term.cols, s.term.rows);
  } catch { /* container hidden / closing */ }
}

// Reflow the active session's terminal (used by the window-resize + pane drags).
export function fitActive() { if (activeId) fit(sessions.get(activeId)); }

// Send raw input to the active session (used by explorer drag-drop and "add to chat").
export function sendToActiveSession(text) {
  if (!activeId) return;
  const s = sessions.get(activeId);
  if (!s) return;
  window.api.sendInput(activeId, text);
  s.term.focus();
}

async function newSession() {
  // probe a size from a temporary fit after open
  const res = await window.api.newSession({ cols: 80, rows: 24 });
  const id = res.id;

  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);

  const term = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  attachClipboard(term, { formatImagePath: (p) => `@${p} ` });
  term.onData((data) => window.api.sendInput(id, data));
  registerTerminalLinks(term);

  const li = document.createElement('li');
  li.dataset.id = id;
  const dot = document.createElement('span');
  dot.className = 'dot working';
  const label = document.createElement('span');
  label.className = 'sess-label';
  label.textContent = 'session ' + id.slice(0, 8);
  const restore = document.createElement('button');
  restore.className = 'sess-restore';
  restore.title = 'Restore session';
  restore.textContent = '↩';
  restore.onclick = (e) => { e.stopPropagation(); setArchived(id, false); };
  const close = document.createElement('button');
  close.className = 'sess-close';
  close.title = 'Archive session';
  close.textContent = '×';
  // First × archives a live session; a second × on the archived row closes it for good.
  close.onclick = (e) => {
    e.stopPropagation();
    const s = sessions.get(id);
    if (s && s.archived) closeSession(id);
    else setArchived(id, true);
  };
  li.append(dot, label, restore, close);
  li.onclick = () => selectSession(id);
  listEl.appendChild(li);

  sessions.set(id, { id, term, fit: fitAddon, container, li, dot, label, closeBtn: close, state: 'working', firstPrompt: '', name: '', files: [], archived: false });
  setTab('active');
  selectSession(id);
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  window.api.killSession(id);
  untrackTermTheme(s.term);
  s.term.dispose();
  s.container.remove();
  s.li.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    selectFirstVisible();
  }
}

// --- session-bar buttons: commit / revert just this session's work ---
sessionCommitBtn.onclick = async () => {
  if (!activeId) return;
  const s = sessions.get(activeId);
  s.commitMsg = '';
  updateSessionBar();
  const r = await window.api.commitSession(s.id);
  if (r.ok) setState(s.id, 'pushed'); // the file list (→ button) is refreshed by the session-meta main re-pushes
  else { s.commitMsg = r.stderr || 'Commit failed'; s.commitMsgClass = 'err'; }
  if (activeId === s.id) updateSessionBar();
  refreshGit();};

// Two-click revert: first click arms, second de-applies just this session's edits.
sessionRevertBtn.onclick = async () => {
  if (!activeId) return;
  if (!sessionRevertBtn.classList.contains('armed')) {
    sessionRevertBtn.classList.add('armed');
    sessionRevertBtn.textContent = 'Revert — sure?';
    return;
  }
  sessionRevertBtn.classList.remove('armed');
  sessionRevertBtn.textContent = 'Revert';
  const s = sessions.get(activeId);
  s.commitMsg = '';
  updateSessionBar();
  const r = await window.api.revertSession(s.id);
  const skipped = r.skipped && r.skipped.length;
  s.commitMsg = !r.ok ? (r.stderr || 'Revert failed')
    : skipped ? `Reverted; ${skipped} file${skipped > 1 ? 's' : ''} skipped (also edited by another session)`
    : 'Reverted';
  s.commitMsgClass = r.ok && !skipped ? 'ok' : 'err';
  if (activeId === s.id) updateSessionBar();
  refreshGit();};

document.getElementById('new-session').onclick = newSession;

for (const btn of sessionTabs.children) btn.onclick = () => setTab(btn.dataset.tab);

// Accept file drops into the active session. Two sources:
//   - the explorer tree, which puts an "@<rel>" mention on text/plain;
//   - the OS (Explorer/Finder), which puts File objects on dataTransfer.files
//     with no text/plain — resolve each to an absolute path and send it as an
//     "@<abs>" mention so Claude can read it.
hostEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
hostEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const text = e.dataTransfer.getData('text/plain');
  if (text) { sendToActiveSession(text); return; }
  const paths = [...e.dataTransfer.files].map(f => window.api.pathForFile(f)).filter(Boolean);
  if (paths.length) sendToActiveSession(paths.map(p => `@${p} `).join(''));
});

// --- IPC streams from the per-session PTYs / hook server ---
window.api.onPtyData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});
window.api.onStatus(({ id, state }) => setState(id, state));
window.api.onSessionMeta(({ id, firstPrompt, files }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.firstPrompt = firstPrompt;
  s.files = files;
  if (id === activeId) updateSessionBar();
});
window.api.onSessionName(({ id, name }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.name = name;
  s.label.textContent = name;
  if (id === activeId) updateSessionBar();
});
