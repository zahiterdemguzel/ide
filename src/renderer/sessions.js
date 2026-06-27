import { Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme } from './shared/terminal.js';
import { hideAllOverlays } from './viewer/center.js';
import { renderDiffInto, renderDiffSplitInto } from './viewer/diff.js';
import { registerTerminalLinks } from './terminal-links.js';
import { refreshGit } from './git-pane.js';
import { confirmDialog } from './shared/confirm.js';
import { showArmHint, hideArmHint } from './shared/arm-hint.js';
import { showWarning } from './shared/warn.js';
import { ensureClaude } from './claude-setup.js';
import { isCompletionTransition, playNotification } from './shared/notify.js';
import { t } from '../i18n/index.js';

// Each session owns its own xterm.js Terminal in a hidden container div;
// switching sessions toggles which container is visible, preserving scrollback.
const sessions = new Map(); // id -> { id, term, fit, container, li, dot, label, state, firstPrompt, name, files, archived }
let activeId = null;
export const getActiveId = () => activeId;

// Which sessions the list shows: 'active' (default) hides archived, 'archived'
// shows only archived, 'all' shows everything.
let currentTab = 'active';

// Sessions are scoped to the project folder they were created in: only the open
// folder's sessions are shown. Switching folders (setSessionsRepo) re-filters the
// list without tearing down the other projects' live terminals.
let currentRepo = null;

const listEl = document.getElementById('session-list');
const sessionTabs = document.getElementById('session-tabs');
const hostEl = document.getElementById('terminal-host');
const emptyHint = document.getElementById('empty-hint');
const sessionBar = document.getElementById('session-bar');
const sessionTitle = document.getElementById('session-title');
const sessionCommitBtn = document.getElementById('session-commit');
const sessionRevertBtn = document.getElementById('session-revert');
const sessionArchiveBtn = document.getElementById('session-archive');
const sessionCommitMsg = document.getElementById('session-commit-msg');
const sessionDiffBtn = document.getElementById('session-diff');
const sessionDiffAdd = document.getElementById('session-diff-add');
const sessionDiffDel = document.getElementById('session-diff-del');
const diffOverlay = document.getElementById('session-diff-overlay');
const diffPanel = document.getElementById('session-diff-panel');
const diffDialogStat = document.getElementById('session-diff-stat');
const diffDialogBody = document.getElementById('session-diff-body');
const diffModeUnifiedBtn = document.getElementById('sdiff-mode-unified');
const diffModeSplitBtn = document.getElementById('sdiff-mode-split');

// Lucide "archive" icon — used both on the session-bar archive button and on
// each sidebar row's archive/close button.
const ARCHIVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
sessionArchiveBtn.innerHTML = ARCHIVE_ICON;

// Lucide "trash-2" icon — the permanent-delete button shown only on archived rows.
const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

const STATE_LABEL = {
  idle: 'Idle',
  working: 'Working',
  'needs-input': 'Needs input',
  completed: 'Completed',
  pushed: 'Committed / pushed',
  interrupted: 'Interrupted',
};

function setState(id, state) {
  const s = sessions.get(id);
  if (!s) return;
  const prev = s.state;
  s.state = state;
  s.dot.className = 'dot ' + state;
  s.dot.title = STATE_LABEL[state] || state;
  // A session that was working has just finished — pull the user's eye back with a
  // one-shot row/dot animation and a chime, since the result is likely off-screen.
  if (isCompletionTransition(prev, state)) celebrateFinish(s);
}

// Replays the "just finished" flash on the row + dot. A re-add of the class can't
// restart a CSS animation while it's still applied, so the class is cleared first
// (reflow) before re-adding — and removed again once the longest animation ends.
function celebrateFinish(s) {
  for (const el of [s.li, s.dot]) {
    el.classList.remove('just-finished');
    void el.offsetWidth; // force reflow so a back-to-back finish re-triggers
    el.classList.add('just-finished');
  }
  clearTimeout(s.finishAnim);
  s.finishAnim = setTimeout(() => {
    s.li.classList.remove('just-finished');
    s.dot.classList.remove('just-finished');
  }, 1300);
  playNotification();
}

export function selectSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  closeDiffDialog(); // the dialog belongs to whichever session was showing
  activeId = id;
  hideAllOverlays();
  emptyHint.style.display = 'none';
  for (const [, o] of sessions) o.container.style.display = o === s ? 'block' : 'none';
  for (const o of listEl.children) o.classList.toggle('active', o.dataset.id === id);
  updateSessionBar();
  if (!s.term) {
    // A non-archived session with no terminal was restored from disk on startup:
    // bring its Claude process back the moment the user looks at it, then re-select
    // to fit and focus the rebuilt terminal. Archived sessions wait for an explicit
    // restore (their placeholder stays put).
    if (s.suspended && !s.archived) resumeSessionUI(s).then(() => { if (activeId === id) selectSession(id); });
    return;
  }
  fit(s);
  // A hidden xterm can't render its viewport; on reveal it keeps a stale scroll
  // position until new output forces a refresh. Snap to the bottom so the latest
  // output is visible immediately rather than only after the first keystroke.
  // The reveal + fit only take effect on the next frame, so snap there too —
  // a synchronous scrollToBottom here runs against the still-stale viewport.
  s.term.scrollToBottom();
  requestAnimationFrame(() => s.term && s.term.scrollToBottom());
  s.term.focus();
}

function sessionInTab(s) {
  if (currentTab === 'all') return true;
  if (currentTab === 'archived') return s.archived;
  return !s.archived; // 'active'
}

// A row is shown only when it both belongs to the open project and matches the
// active tab. currentRepo is null until restoreSessions resolves the open folder;
// treat that startup window as "no filter yet" so nothing is hidden prematurely.
function sessionVisible(s) {
  if (currentRepo !== null && s.repo !== currentRepo) return false;
  return sessionInTab(s);
}

// Show/hide rows for the current tab + project and keep each row's archived
// styling/title in sync with its state.
function applyTabFilter() {
  for (const [, s] of sessions) {
    s.li.style.display = sessionVisible(s) ? '' : 'none';
    s.li.classList.toggle('archived', s.archived);
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
  emptyHint.style.display = 'flex';
  updateSessionBar();
}

function setTab(tab) {
  currentTab = tab;
  for (const btn of sessionTabs.children) btn.classList.toggle('active', btn.dataset.tab === tab);
  applyTabFilter();
  // The selected session may not belong to the new tab anymore.
  const s = sessions.get(activeId);
  if (!s || !sessionVisible(s)) selectFirstVisible();
}

// Re-point the list at a different project folder: re-filter and fall back to the
// new folder's first session (or the empty hint) when the selection moved away.
export function setSessionsRepo(repo) {
  currentRepo = repo;
  applyTabFilter();
  const s = sessions.get(activeId);
  if (!s || !sessionVisible(s)) selectFirstVisible();
}

async function setArchived(id, archived) {
  const s = sessions.get(id);
  if (!s) return;
  if (archived) suspendSessionUI(s);
  else await resumeSessionUI(s);
  s.archived = archived;
  applyTabFilter();
  if (activeId === id && !sessionVisible(s)) selectFirstVisible();
  else if (!archived && activeId === id) selectSession(id); // re-fit the rebuilt terminal
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
  if (sessionRevertBtn.classList.contains('armed')) hideArmHint();
  sessionRevertBtn.classList.remove('armed');
  sessionRevertBtn.textContent = 'Revert';
  sessionArchiveBtn.style.display = s.archived ? 'none' : '';
  const name = s.name || (s.firstPrompt && s.firstPrompt.split('\n')[0]) || t('session.unnamed');
  sessionTitle.textContent = name;
  sessionTitle.title = name;
  renderCommitButton(s);
  renderDiffButton(s);
  // The notice is now only for failures / revert results, kept per-session so
  // switching sessions never carries a stale message over from another.
  sessionCommitMsg.textContent = s.commitMsg || '';
  sessionCommitMsg.className = 'git-msg ' + (s.commitMsgClass || '');
}

// The commit button reports commit state: live "Commit N files" while edits
// remain, disabled "Nothing to commit" once empty. A successful commit forgets
// those files (main re-pushes session-meta), so the same button works repeatedly
// across a session — it re-enables as soon as the session edits again.
//
// The count must match what a commit would ACTUALLY commit, not every file the
// session ever touched: `s.files` (trackedFiles) includes empty-patch files —
// ones whose net change vs HEAD is now nothing (already committed elsewhere, or
// edited-then-reverted) — which commit-session drops. `s.diffStat.files` is that
// real committable count (same sessionEntries filter the commit uses), so prefer
// it; fall back to the raw tracked count only until the first stat arrives.
function renderCommitButton(s) {
  const n = s.diffStat ? s.diffStat.files : s.files.length;
  sessionCommitBtn.disabled = n === 0;
  sessionCommitBtn.textContent = n ? `Commit ${n} file${n > 1 ? 's' : ''}` : 'Nothing to commit';
}

// The Diff button shows this session's net change as a green +added / red
// -removed badge and is disabled when the session changed nothing. The counts
// come from `s.diffStat` (computed by main); until that first arrives we fall
// back to the tracked-file count so the button still enables when there is work.
function renderDiffButton(s) {
  const ds = s.diffStat;
  const hasChange = ds ? ds.files > 0 : s.files.length > 0;
  sessionDiffBtn.disabled = !hasChange;
  if (ds && ds.files > 0) {
    sessionDiffAdd.textContent = '+' + ds.additions;
    sessionDiffDel.textContent = '-' + ds.deletions;
    sessionDiffAdd.style.display = '';
    sessionDiffDel.style.display = '';
  } else {
    sessionDiffAdd.style.display = 'none';
    sessionDiffDel.style.display = 'none';
  }
}

// Pull this session's diff stat from main and re-render its button. Debounced per
// session so a burst of edits (or a background session churning) doesn't spawn a
// git diff per keystroke. Driven off every session-meta — which main pushes for
// the active AND background sessions — so a session working out of view keeps its
// badge current; also on restore and select.
const diffStatTimers = new Map();
function refreshDiffStat(id) {
  if (diffStatTimers.has(id)) clearTimeout(diffStatTimers.get(id));
  diffStatTimers.set(id, setTimeout(async () => {
    diffStatTimers.delete(id);
    const s = sessions.get(id);
    if (!s) return;
    try { s.diffStat = await window.api.sessionDiffStat(id); } catch { return; }
    if (id === activeId) { renderCommitButton(s); renderDiffButton(s); }
  }, 350));
}

export function fit(s) {
  if (!s || !s.fit || !s.term) return; // suspended sessions have no terminal
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
  if (!s || !s.term) return; // archived session: nothing to send input to
  window.api.sendInput(activeId, text);
  s.term.focus();
}

// Create an xterm.js terminal inside an existing container and wire its
// input/links. Split out from buildTerminal so a suspended session can rebuild
// its terminal into the same container on restore.
function attachTerminal(id, container) {
  const term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  attachClipboard(term, { formatImagePath: (p) => `@${p} ` });
  term.onData((data) => window.api.sendInput(id, data));
  registerTerminalLinks(term);
  return { term, fit: fitAddon };
}

// Build the xterm.js terminal (in its own hidden container) for a session id.
// Used for a fresh session; resuming a suspended one reuses the container via
// attachTerminal — the row, dot, and tracked-file state outlive the terminal.
function buildTerminal(id) {
  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);
  const { term, fit } = attachTerminal(id, container);
  return { container, term, fit };
}

// Archive a live session: tell main to kill the Claude process (it keeps the
// session entry and all its uncommitted tracked-file state for a later resume)
// and dispose the renderer terminal to free its memory. s.files is untouched, so
// the work stays committable and the tracking history survives the archive.
function suspendSessionUI(s) {
  if (s.suspended) return;
  s.suspended = true;
  window.api.suspendSession(s.id);
  if (s.term) {
    untrackTermTheme(s.term);
    s.term.dispose();
    s.term = null;
    s.fit = null;
  }
  showSuspendedHint(s.container, 'Session archived to free resources — restore it to continue.');
}

// Restore an archived session: respawn its Claude conversation under the same id
// (`--resume`, so main keeps accumulating tracked edits against the same entry)
// and rebuild the terminal in place. The terminal must exist before resume so the
// first pty-data the resumed process emits has somewhere to render.
async function resumeSessionUI(s) {
  if (!s.suspended) return;
  s.suspended = false;
  s.container.classList.remove('suspended');
  s.container.replaceChildren();
  const { term, fit } = attachTerminal(s.id, s.container);
  s.term = term;
  s.fit = fit;
  await window.api.resumeSession(s.id, { cols: term.cols || 80, rows: term.rows || 24 });
}

// Build the sidebar row (dot + label + restore/close buttons) and wire its
// handlers. Shared by a fresh session and a session restored from disk on startup.
function makeRow(id) {
  const li = document.createElement('li');
  li.dataset.id = id;
  const dot = document.createElement('span');
  dot.className = 'dot idle';
  const label = document.createElement('span');
  label.className = 'sess-label';
  label.textContent = t('session.unnamed');
  const restore = document.createElement('button');
  restore.className = 'sess-restore';
  restore.title = 'Restore session';
  restore.textContent = '↩';
  restore.onclick = (e) => { e.stopPropagation(); setArchived(id, false); };
  const close = document.createElement('button');
  close.className = 'sess-close';
  close.title = 'Archive session';
  close.innerHTML = ARCHIVE_ICON;
  // The archive button only ever archives; archived rows hide it (CSS) and expose
  // the trash button below for permanent deletion. Middle-clicking a live row also
  // archives it (matching the git-pane terminal tabs).
  const archiveOrDelete = () => {
    const s = sessions.get(id);
    if (s && s.archived) closeSession(id);
    else setArchived(id, true);
  };
  close.onclick = (e) => { e.stopPropagation(); setArchived(id, true); };
  const del = document.createElement('button');
  del.className = 'sess-delete';
  del.title = 'Delete session permanently';
  del.innerHTML = TRASH_ICON;
  // Permanent deletion can't be undone, so it arms on the first click (the comic
  // bubble prompts the confirm) and only deletes on the second — the same two-click
  // pattern as the git pane's discard/revert buttons.
  del.onclick = (e) => {
    e.stopPropagation();
    if (!del.classList.contains('armed')) {
      del.classList.add('armed');
      del.title = t('armHint.deleteSession');
      showArmHint(del);
      return;
    }
    hideArmHint();
    closeSession(id);
  };
  li.append(dot, label, restore, del, close);
  li.onclick = () => selectSession(id);
  li.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); archiveOrDelete(); } };
  listEl.appendChild(li);
  return { li, dot, label, closeBtn: close };
}

// Replace a container's contents with the "archived, restore to continue" hint
// shown when a session has no live terminal. Shared by archive and startup-restore.
function showSuspendedHint(container, text) {
  container.classList.add('suspended');
  const hint = document.createElement('div');
  hint.className = 'term-suspended-hint';
  hint.textContent = text;
  container.replaceChildren(hint);
}

export async function newSession() {
  // Don't spawn a session if the Claude Code CLI is missing — guide the user to
  // install it first (the gate re-checks and shows the setup dialog if needed).
  if (!(await ensureClaude())) return;
  // probe a size from a temporary fit after open
  const res = await window.api.newSession({ cols: 80, rows: 24 });
  // A failed spawn already raised a session-error dialog from main; bail rather
  // than build a broken row around a missing id.
  if (!res || !res.id) return;
  const id = res.id;
  if (res.repo) currentRepo = res.repo;

  const { container, term, fit: fitAddon } = buildTerminal(id);
  const { li, dot, label, closeBtn } = makeRow(id);

  sessions.set(id, { id, repo: res.repo || currentRepo, term, fit: fitAddon, container, li, dot, label, closeBtn, state: 'idle', firstPrompt: '', name: '', files: [], archived: false, suspended: false });
  setTab('active');
  selectSession(id);
}

// Spawn a fresh session and pre-type a message into it (e.g. the git pane handing
// off a merge/conflict resolution). The message is queued per id and typed once the
// session's terminal shows its first output — Claude's input box isn't ready the
// instant the PTY spawns, so we wait for it to paint. It is left UNSENT (no Enter)
// so the user reviews it and submits, rather than risk it firing before Claude is ready.
const pendingPrompts = new Map();
export async function newSessionWithPrompt(text) {
  await newSession();
  const id = getActiveId();
  if (id) pendingPrompts.set(id, text);
}

// Rebuild a row for a session restored from disk on startup. It has no live
// terminal yet (the Claude process can't outlive the app); the placeholder invites
// the user to resume it, which selectSession does on demand. Its tracked-file list
// is intact, so the commit button works against it before it's even resumed.
function restoreSessionRow(meta) {
  const { id, repo, firstPrompt, name, archived, files, state } = meta;
  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);
  showSuspendedHint(container, archived
    ? 'Session archived — restore it to continue.'
    : 'Session restored — select to resume.');
  const { li, dot, label, closeBtn } = makeRow(id);
  const shown = name || (firstPrompt && firstPrompt.split('\n')[0]);
  if (shown) label.textContent = shown;
  // Carry the persisted status dot across the restart: finished stays green,
  // committed stays purple, an untouched session stays gray, and only a session
  // that was actively running reopens red (interrupted). Selecting it resumes the
  // Claude process, which then drives the dot live again.
  const st = state || 'idle';
  dot.className = 'dot ' + st;
  dot.title = STATE_LABEL[st] || st;
  sessions.set(id, { id, repo: repo || '', term: null, fit: null, container, li, dot, label, closeBtn, state: st, firstPrompt: firstPrompt || '', name: name || '', files: files || [], archived, suspended: true });
}

// On startup, pull the persisted sessions from main and rebuild the list, then
// surface the first active one (selecting it resumes its Claude process).
export async function restoreSessions() {
  // Resolve the open folder first so the restored list is filtered to it from the
  // start (a session belongs to the project it was created in).
  try { currentRepo = await window.api.getRepoPath(); } catch {}
  let list = [];
  try { list = await window.api.getSessions(); } catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  for (const meta of list) restoreSessionRow(meta);
  setTab('active');
  selectFirstVisible();
  // Populate the Diff badges for sessions that left uncommitted work; main has no
  // push trigger for a restored (idle) session, so pull each one's stat once.
  for (const [, s] of sessions) if (s.files.length) refreshDiffStat(s.id);
}

// Tear down a session's UI without telling main to kill it (used both for an
// explicit close and when main evicts an old session past the storage budget).
function removeSessionUI(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.term) { untrackTermTheme(s.term); s.term.dispose(); }
  s.container.remove();
  s.li.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    selectFirstVisible();
  }
}

function closeSession(id) {
  if (!sessions.has(id)) return;
  window.api.killSession(id);
  removeSessionUI(id);
}

// --- session-bar buttons: commit / revert just this session's work ---
sessionCommitBtn.onclick = async () => {
  if (!activeId) return;
  const s = sessions.get(activeId);
  // The session is still working (yellow); its file set may be mid-change, so
  // confirm before committing a moving target.
  if (s.state === 'working' && !(await confirmDialog({
    title: 'Commit while running?',
    message: 'This session is still running. Its files may still be changing. Commit now anyway?',
    ok: 'Commit',
  }))) return;
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
    showArmHint(sessionRevertBtn);
    return;
  }
  hideArmHint();
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

sessionArchiveBtn.onclick = () => { if (activeId) setArchived(activeId, true); };

// --- per-session Diff dialog: floats over the live terminal (kept alive behind
// it, so the user doesn't lose track of which session it is). Closes on the ×, on
// any click outside the panel (so they can go straight to committing), on Escape,
// and when the session changes.
let diffDialogId = null;
let diffMode = 'unified';   // 'unified' (single column) | 'split' (side-by-side); persists across opens
let diffPatchText = null;   // the open dialog's patch, kept so the mode toggle re-renders without re-fetching

export function closeDiffDialog() {
  if (diffDialogId === null) return;
  diffDialogId = null;
  diffPatchText = null;
  diffOverlay.hidden = true;
  diffDialogBody.innerHTML = '';
  document.removeEventListener('mousedown', onDiffOutside, true);
  document.removeEventListener('keydown', onDiffKey, true);
}

// Render the held patch in the active mode and reflect it on the toggle buttons.
function renderDiffDialog() {
  diffModeUnifiedBtn.classList.toggle('active', diffMode === 'unified');
  diffModeSplitBtn.classList.toggle('active', diffMode === 'split');
  diffPanel.classList.toggle('split', diffMode === 'split');
  if (diffPatchText == null) return;
  if (diffMode === 'split') renderDiffSplitInto(diffDialogBody, diffPatchText, null);
  else renderDiffInto(diffDialogBody, diffPatchText, null, true);
}

function setDiffMode(mode) {
  if (diffMode === mode) return;
  diffMode = mode;
  renderDiffDialog();
}

function onDiffOutside(e) {
  if (diffPanel.contains(e.target) || sessionDiffBtn.contains(e.target)) return;
  closeDiffDialog();
}
function onDiffKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeDiffDialog(); } }

async function openDiffDialog() {
  const id = activeId;
  const s = sessions.get(id);
  if (!s) return;
  diffDialogId = id;
  diffOverlay.hidden = false;
  diffDialogStat.textContent = '';
  diffDialogBody.innerHTML = '<div class="editor-notice">…</div>';
  document.addEventListener('mousedown', onDiffOutside, true);
  document.addEventListener('keydown', onDiffKey, true);
  let r = null;
  try { r = await window.api.sessionDiff(id); } catch { /* gone */ }
  if (diffDialogId !== id) return; // closed or switched while the diff was computing
  // Keep the button's badge in agreement with what the dialog actually shows.
  if (r) { s.diffStat = { additions: r.additions, deletions: r.deletions, files: r.files }; renderCommitButton(s); renderDiffButton(s); }
  if (!r || !r.ok || !r.files) {
    diffPatchText = null;
    diffDialogStat.textContent = '';
    diffDialogBody.innerHTML = '';
    const notice = document.createElement('div');
    notice.className = 'editor-notice';
    notice.textContent = t('session.diffEmpty');
    diffDialogBody.appendChild(notice);
    return;
  }
  diffDialogStat.innerHTML = `<span class="sdiff-add">+${r.additions}</span><span class="sdiff-del">-${r.deletions}</span>`;
  diffPatchText = r.patch;
  renderDiffDialog();
}

sessionDiffBtn.onclick = () => { if (diffDialogId === null) openDiffDialog(); else closeDiffDialog(); };
document.getElementById('session-diff-close').onclick = closeDiffDialog;
diffModeUnifiedBtn.onclick = () => setDiffMode('unified');
diffModeSplitBtn.onclick = () => setDiffMode('split');

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
  if (s && s.term) s.term.write(data);
  // First output means Claude's TUI is painting — give it a beat to ready its
  // input box, then drop in any queued message (see newSessionWithPrompt).
  if (pendingPrompts.has(id)) {
    const text = pendingPrompts.get(id);
    pendingPrompts.delete(id);
    setTimeout(() => window.api.sendInput(id, text), 1000);
  }
});
window.api.onStatus(({ id, state }) => setState(id, state));
window.api.onSessionMeta(({ id, firstPrompt, files }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.firstPrompt = firstPrompt;
  s.files = files;
  if (id === activeId) updateSessionBar();
  // session-meta fires for background sessions too, so refreshing the diff stat
  // here keeps an out-of-view session's badge current.
  refreshDiffStat(id);
  // A session just touched the working tree, so the shared git pane is now stale.
  // Refresh it immediately (debounced) instead of waiting up to 3s for the poll,
  // so the Changes list always reflects what the agent just did.
  scheduleGitRefresh();
});

// Coalesce the git-pane refreshes a burst of edits would trigger into one shortly
// after activity settles — the pane reads the whole repo, so per-edit refreshes
// would be wasteful, but the user still sees changes appear within a beat.
let gitRefreshTimer = null;
function scheduleGitRefresh() {
  if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(() => { gitRefreshTimer = null; refreshGit(); }, 400);
}
window.api.onSessionName(({ id, name }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.name = name;
  s.label.textContent = name;
  if (id === activeId) updateSessionBar();
});
// Main evicted the oldest sessions to stay under the persisted-storage budget;
// drop their rows so the UI matches what survives on disk.
window.api.onSessionEvicted(({ ids }) => { for (const id of ids) removeSessionUI(id); });
// A session failed in main (saving/retrieving/committing/…). Rather than crash or
// vanish into the console, surface it as a dismissable warning with the error text.
window.api.onSessionError(({ context, message }) => {
  const detail = context ? `${t('warn.session')} (${context}):\n\n${message}` : message;
  showWarning(detail, t('warn.session'));
});
