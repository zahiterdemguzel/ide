import { Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme, attachRenderer } from './shared/terminal.js';
import { hideAllOverlays } from './viewer/center.js';
import { renderDiffInto, renderDiffSplitInto } from './viewer/diff.js';
import { registerTerminalLinks } from './terminal-links.js';
import { refreshGit } from './git-pane.js';
import { confirmDialog } from './shared/confirm.js';
import { showArmHint, hideArmHint } from './shared/arm-hint.js';
import { showWarning } from './shared/warn.js';
import { ensureClaude } from './claude-setup.js';
import { isCompletionTransition, playNotification } from './shared/notify.js';
import { compileQuery, matchesTerms } from './shared/name-match.js';
import { nextSessionId } from './shared/session-cycle.js';
import { MODELS, getSessionModel, getSubagentModel, setSessionModel } from './settings.js';
import { t } from '../i18n/index.js';

// Each session owns its own xterm.js Terminal in a hidden container div;
// switching sessions toggles which container is visible, preserving scrollback.
const sessions = new Map(); // id -> { id, term, fit, container, li, dot, label, state, firstPrompt, name, files, archived }
let activeId = null;
export const getActiveId = () => activeId;

// Which sessions the list shows: 'active' (default) hides archived, 'archived'
// shows only archived, 'all' shows everything.
let currentTab = 'active';

// Compiled query terms for the Archived-tab search bar (empty = no filter). The
// matching mirrors the explorer's filename search (shared/name-match.js).
let archivedTerms = [];

// Sessions are scoped to the project folder they were created in: only the open
// folder's sessions are shown. Switching folders (setSessionsRepo) re-filters the
// list without tearing down the other projects' live terminals.
// undefined = not resolved yet (startup window, no filter); null = resolved to
// "no project open" (hide every project-bound session); string = the open folder.
let currentRepo;

// Optional per-row "+added -removed" diff badge in the sessions list. Off by
// default; toggled from settings. Persists in localStorage.
const SESS_DIFF_BADGE_STORE = 'ide.sessionDiffBadge';
let sessionDiffBadge = localStorage.getItem(SESS_DIFF_BADGE_STORE) === 'true';

export function isSessionDiffBadgeEnabled() { return sessionDiffBadge; }
export function setSessionDiffBadge(on) {
  sessionDiffBadge = !!on;
  localStorage.setItem(SESS_DIFF_BADGE_STORE, sessionDiffBadge ? 'true' : 'false');
  for (const [, s] of sessions) renderRowDiff(s);
}

// Optional OS-level desktop notification on the same working -> completed
// transition that triggers the chime (see celebrateFinish). Off by default —
// stealing window focus is more intrusive than a chime, so it's opt-in.
const OS_NOTIFY_STORE = 'ide.osNotifications';
let osNotifyEnabled = localStorage.getItem(OS_NOTIFY_STORE) === 'true';

export function isOsNotificationsEnabled() { return osNotifyEnabled; }
export function setOsNotificationsEnabled(on) {
  osNotifyEnabled = !!on;
  localStorage.setItem(OS_NOTIFY_STORE, osNotifyEnabled ? 'true' : 'false');
}

const listEl = document.getElementById('session-list');
const sessionTabs = document.getElementById('session-tabs');
const sessionSearch = document.getElementById('session-search');
const hostEl = document.getElementById('terminal-host');
const emptyHint = document.getElementById('empty-hint');
const sessionBar = document.getElementById('session-bar');
const sessionTitle = document.getElementById('session-title');
const sessionCommitBtn = document.getElementById('session-commit');
const sessionRevertBtn = document.getElementById('session-revert');
const sessionArchiveBtn = document.getElementById('session-archive');
const sessionCommitMsg = document.getElementById('session-commit-msg');
const sessionModelBtn = document.getElementById('session-model');
const sessionModelLabel = document.getElementById('session-model-label');
const sessionModelMenu = document.getElementById('session-model-badge-menu');
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
const ARCHIVE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>';
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
  // The animation always plays; the chime is the user's chosen sound, and is
  // silent when they've picked "None" in settings.
  playNotification();
  // The OS notification is opt-in (it can pull focus away from whatever the user
  // is doing) and asks main to show it, since only main can raise/focus the window.
  if (osNotifyEnabled) {
    const name = s.name || (s.firstPrompt && s.firstPrompt.split('\n')[0]) || t('session.unnamed');
    window.api.notifySessionFinished({ id: s.id, title: t('notify.sessionFinishedTitle'), body: name });
  }
}

export function selectSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  closeDiffDialog(); // the dialog belongs to whichever session was showing
  activeId = id;
  hideAllOverlays();
  emptyHint.style.display = 'none';
  // Only the visible terminal keeps a GPU renderer (see attachRenderer): release
  // every other session's so live WebGL contexts stay well under Chromium's cap.
  for (const [, o] of sessions) {
    o.container.style.display = o === s ? 'block' : 'none';
    if (o !== s && o.renderer) { o.renderer.dispose(); o.renderer = null; }
  }
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
  if (!s.renderer) s.renderer = attachRenderer(s.term);
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
// active tab. currentRepo is undefined until restoreSessions resolves the open
// folder; treat that startup window as "no filter yet" so nothing is hidden
// prematurely. A resolved null (no project open) hides every session.
// A session's searchable text: its generated title plus its first prompt — the
// same identity a sidebar row shows, so a query matches what the user reads.
function sessionHaystack(s) {
  return `${s.name || ''} ${s.firstPrompt || ''}`;
}

function sessionVisible(s) {
  if (currentRepo !== undefined && s.repo !== currentRepo) return false;
  if (!sessionInTab(s)) return false;
  // The search bar only filters the Archived tab (where it's shown).
  if (currentTab === 'archived' && archivedTerms.length) return matchesTerms(archivedTerms, sessionHaystack(s));
  return true;
}

// Show/hide rows for the current tab + project and keep each row's archived
// styling/title in sync with its state. The archived tab lists newest-first
// (reverse creation order) so the most recently archived session is on top.
function applyTabFilter() {
  const rows = [...sessions.values()];
  if (currentTab === 'archived') rows.reverse();
  for (const s of rows) {
    s.li.style.display = sessionVisible(s) ? '' : 'none';
    s.li.classList.toggle('archived', s.archived);
    listEl.appendChild(s.li); // re-order the row to match the active tab's sort
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
  // The search bar lives on the Archived tab only; leaving it clears the filter.
  const onArchived = tab === 'archived';
  sessionSearch.hidden = !onArchived;
  if (!onArchived && archivedTerms.length) { sessionSearch.value = ''; archivedTerms = []; }
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
  // Unarchiving reveals the badge — its stat was skipped while archived, so pull
  // it now (no-op when it has no tracked work).
  if (!archived && s.files.length) refreshDiffStat(id);
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
  renderModelBadge(s);
  renderCommitButton(s);
  renderDiffButton(s);
  // The notice is now only for failures / revert results, kept per-session so
  // switching sessions never carries a stale message over from another.
  sessionCommitMsg.textContent = s.commitMsg || '';
  sessionCommitMsg.className = 'git-msg ' + (s.commitMsgClass || '');
}

// --- per-session model: badge in the session bar + model dropdown ---
// A session's model is stored on its record (persisted, re-applied on resume) and
// can be changed live: choosing one drives the CLI's `/model` command in the running
// session (see main's set-session-model), and a `/model <id>` typed straight into the
// terminal is mirrored back onto the badge (see onSessionModel). An empty/absent
// value means the CLI default, shown as "Default".
const MODEL_NAME = new Map(MODELS.map((m) => [m.id, m.name]));
function modelId(s) {
  const v = s && s.model;
  return MODEL_NAME.has(v) ? v : 'default';
}
// The pill keeps the "Default (inherit)" wording short — it's just "Default" here.
function modelBadgeText(id) {
  return id === 'default' ? 'Default' : (MODEL_NAME.get(id) || id);
}

function renderModelBadge(s) {
  sessionModelLabel.textContent = modelBadgeText(modelId(s));
}

function closeModelBadgeMenu() {
  if (sessionModelMenu.hidden) return;
  sessionModelMenu.classList.remove('open');
  sessionModelBtn.setAttribute('aria-expanded', 'false');
  sessionModelMenu.addEventListener('transitionend', () => { sessionModelMenu.hidden = true; }, { once: true });
}
function openModelBadgeMenu() {
  const s = sessions.get(activeId);
  if (!s) return;
  const current = modelId(s);
  sessionModelMenu.replaceChildren();
  for (const m of MODELS) {
    if (m.id === 'default') continue; // inherit sentinel isn't a picker choice
    const item = document.createElement('button');
    item.className = 'effort-menu-item model-item' + (m.id === current ? ' current' : '');
    const label = document.createElement('span');
    label.textContent = m.name;
    item.append(label);
    item.onclick = () => { closeModelBadgeMenu(); chooseModel(m.id); };
    sessionModelMenu.appendChild(item);
  }
  sessionModelMenu.hidden = false;
  sessionModelBtn.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => sessionModelMenu.classList.add('open'));
}

// Apply a chosen model to the active session: update its record + badge, remember it
// as the default for the next session, and tell main to switch the live session.
function chooseModel(model) {
  const s = sessions.get(activeId);
  if (!s) return;
  s.model = model;
  renderModelBadge(s);
  setSessionModel(model);
  window.api.setSessionModel(activeId, model);
}

sessionModelBtn.onclick = (e) => {
  e.stopPropagation();
  if (sessionModelMenu.hidden) openModelBadgeMenu(); else closeModelBadgeMenu();
};
document.addEventListener('click', (e) => {
  if (!sessionModelMenu.hidden && !sessionModelMenu.contains(e.target) && !sessionModelBtn.contains(e.target)) closeModelBadgeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelBadgeMenu(); });

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
  // While a commit is in flight (snapshot + the Haiku message call, up to ~30s),
  // this session's button shows a spinner and stays disabled — only this button,
  // so the rest of the app (other sessions, the git pane) is never blocked.
  // `s.committing` lives on the session so switching away and back keeps it.
  if (s.committing) {
    sessionCommitBtn.disabled = true;
    sessionCommitBtn.textContent = 'Writing commit message…';
    return;
  }
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

// Mirror a session's diff stat onto its sidebar row as a small green/red badge,
// when the setting is on and the session has net changes — otherwise hide it.
function renderRowDiff(s) {
  const el = s.diffBadge;
  if (!el) return;
  const ds = s.diffStat;
  if (sessionDiffBadge && ds && ds.files > 0) {
    el.innerHTML = `<span class="sess-diff-add">+${ds.additions}</span><span class="sess-diff-del">-${ds.deletions}</span>`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
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
    renderRowDiff(s); // every session: keep out-of-view rows' badges current
    if (id === activeId) { renderCommitButton(s); renderDiffButton(s); }
  }, 350));
}

// Re-validate every session's diff stat. A session's count is computed against
// HEAD, so it goes stale whenever HEAD moves underneath it — a commit from the
// main git pane, a commit from another session, or a file changed on disk — none
// of which fire that session's own session-meta. The git pane calls this from
// refreshGit() (the choke point hit after any commit, on the poll, and on focus)
// whenever the working-tree state actually changed, so a button reading
// "Commit 2 files" corrects to "Nothing to commit" without the user opening the
// diff to force it. Each per-session refresh is debounced, so duplicate triggers
// (this plus a concurrent session-meta) coalesce.
export function refreshAllDiffStats() {
  for (const [, s] of sessions) {
    // Archived sessions never compute a diff stat — their badge isn't shown while
    // they sit in the Archived tab, and a stat spawns several git processes.
    // Hundreds of them fanning out on launch is what made the app crawl on open.
    // An archived row keeps its tracked-file-count fallback and gets its real
    // stat only when it's unarchived (setArchived → refreshDiffStat).
    if (s.archived) continue;
    if (s.files.length || (s.diffStat && s.diffStat.files)) refreshDiffStat(s.id);
  }
}

export function fit(s) {
  if (!s || !s.fit || !s.term) return; // suspended sessions have no terminal
  // A phone holds this session: its PTY is sized to the phone's screen and main
  // would drop our resize anyway. Don't reflow the covered xterm either — it
  // should keep mirroring the phone-sized output for an instant takeover.
  if (s.controlled) return;
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
  if (s.controlled) return; // a phone holds it — don't type into someone else's PTY
  window.api.sendInput(activeId, text);
  s.term.focus();
}

// Create an xterm.js terminal inside an existing container and wire its
// input/links. Split out from buildTerminal so a suspended session can rebuild
// its terminal into the same container on restore.
function attachTerminal(id, container, repo) {
  const term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  attachClipboard(term, { formatImagePath: (p) => `@${p} ` });
  term.onData((data) => window.api.sendInput(id, data));
  registerTerminalLinks(term, repo);
  return { term, fit: fitAddon };
}

// Build the xterm.js terminal (in its own hidden container) for a session id.
// Used for a fresh session; resuming a suspended one reuses the container via
// attachTerminal — the row, dot, and tracked-file state outlive the terminal.
function buildTerminal(id, repo) {
  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);
  const { term, fit } = attachTerminal(id, container, repo);
  return { container, term, fit };
}

// Archive a live session: tell main to kill the Claude process (it keeps the
// session entry and all its uncommitted tracked-file state for a later resume)
// and dispose the renderer terminal to free its memory. s.files is untouched, so
// the work stays committable and the tracking history survives the archive.
// `notifyMain: false` when the archive originated elsewhere (a paired phone): main
// has already killed the PTY, so re-sending suspend-session would be a no-op echo.
function suspendSessionUI(s, { notifyMain = true } = {}) {
  if (s.suspended) return;
  s.suspended = true;
  if (notifyMain) window.api.suspendSession(s.id);
  if (s.term) {
    if (s.renderer) { s.renderer.dispose(); s.renderer = null; }
    untrackTermTheme(s.term);
    s.term.dispose();
    s.term = null;
    s.fit = null;
  }
  showSuspendedHint(s.container, 'Session archived to free resources — restore it to continue.');
  clearControlled(s); // the hint replaced the container's children, cover included
}

// Restore an archived session: respawn its Claude conversation under the same id
// (`--resume`, so main keeps accumulating tracked edits against the same entry)
// and rebuild the terminal in place. The terminal must exist before resume so the
// first pty-data the resumed process emits has somewhere to render.
// Swap the "archived" placeholder for a live terminal. Split out of resumeSessionUI
// because a session restored from a phone is already respawned by the time the
// desktop hears about it: it needs the terminal rebuilt but not a second resume.
function rebuildTerminalUI(s) {
  s.suspended = false;
  s.container.classList.remove('suspended');
  s.container.replaceChildren(); // drops the cover node with everything else
  clearControlled(s);
  const { term, fit } = attachTerminal(s.id, s.container, s.repo);
  s.term = term;
  s.fit = fit;
  s.renderer = null; // re-attached by selectSession when this session is shown
  return term;
}

async function resumeSessionUI(s) {
  if (!s.suspended) return;
  const term = rebuildTerminalUI(s);
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
  const diffBadge = document.createElement('span');
  diffBadge.className = 'sess-diff';
  diffBadge.style.display = 'none';
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
  li.append(dot, label, diffBadge, restore, del, close);
  li.onclick = () => selectSession(id);
  li.onauxclick = (e) => { if (e.button === 1) { e.preventDefault(); archiveOrDelete(); } };
  listEl.appendChild(li);
  return { li, dot, label, diffBadge, closeBtn: close };
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

// `opts.model` / `opts.subagentModel` override the saved settings defaults for
// this one session (the per-session picker passes them); omitted means use the
// defaults. The chosen models ride to main, which turns them into the CLI's
// ANTHROPIC_MODEL / CLAUDE_CODE_SUBAGENT_MODEL env (see src/main/agent-models.js).
export async function newSession(opts = {}) {
  // Don't spawn a session if the Claude Code CLI is missing — guide the user to
  // install it first (the gate re-checks and shows the setup dialog if needed).
  if (!(await ensureClaude())) return;
  const model = opts.model || getSessionModel();
  const subagentModel = opts.subagentModel || getSubagentModel();
  // probe a size from a temporary fit after open
  const res = await window.api.newSession({ cols: 80, rows: 24, model, subagentModel });
  // A failed spawn already raised a session-error dialog from main; bail rather
  // than build a broken row around a missing id.
  if (!res || !res.id) return;
  const id = res.id;
  if (res.repo) currentRepo = res.repo;
  const repo = res.repo || currentRepo;

  // The sessions-changed push racing this call may have adopted the row already
  // (both paths build the same live row) — reuse it rather than duplicating it.
  if (!sessions.has(id)) {
    const { container, term, fit: fitAddon } = buildTerminal(id, repo);
    const { li, dot, label, diffBadge, closeBtn } = makeRow(id);
    sessions.set(id, { id, repo, term, fit: fitAddon, container, li, dot, label, diffBadge, closeBtn, state: 'idle', firstPrompt: '', name: '', files: [], archived: false, suspended: false, model });
  }
  setTab('active');
  selectSession(id);
}

// Spawn a fresh session and pre-type a message into it (e.g. the git pane handing
// off a merge/conflict resolution). The message is queued per id and typed once the
// session's terminal shows its first output — Claude's input box isn't ready the
// instant the PTY spawns, so we wait for it to paint. The text and the Enter are
// sent in two steps (see onPtyData) so the TUI registers the input before submit.
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
  const { id, repo, firstPrompt, name, archived, files, state, model } = meta;
  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);
  showSuspendedHint(container, archived
    ? 'Session archived — restore it to continue.'
    : 'Session restored — select to resume.');
  const { li, dot, label, diffBadge, closeBtn } = makeRow(id);
  const shown = name || (firstPrompt && firstPrompt.split('\n')[0]);
  if (shown) label.textContent = shown;
  // Carry the persisted status dot across the restart: finished stays green,
  // committed stays purple, an untouched session stays gray, and only a session
  // that was actively running reopens red (interrupted). Selecting it resumes the
  // Claude process, which then drives the dot live again.
  const st = state || 'idle';
  dot.className = 'dot ' + st;
  dot.title = STATE_LABEL[st] || st;
  sessions.set(id, { id, repo: repo || '', term: null, fit: null, container, li, dot, label, diffBadge, closeBtn, state: st, firstPrompt: firstPrompt || '', name: name || '', files: files || [], archived, suspended: true, model: model || '' });
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
  // Active sessions only (refreshAllDiffStats skips archived ones): each stat
  // spawns several git processes, and most restored sessions sit archived and
  // unseen — computing all of them here is what used to make the app crawl on
  // launch. An archived row keeps its tracked-file-count fallback and gets a real
  // stat only when it's unarchived.
  refreshAllDiffStats();
}

// Build a live row for a session that was created on another client (a paired
// phone): its Claude process is already running in main, so it gets a real terminal
// straight away — pty-data is broadcast to every client, so both screens show the
// same conversation.
function adoptSession(meta) {
  const repo = meta.repo || currentRepo || '';
  const { container, term, fit } = buildTerminal(meta.id, repo);
  const { li, dot, label, diffBadge, closeBtn } = makeRow(meta.id);
  const state = meta.state || 'idle';
  const shown = meta.name || (meta.firstPrompt && meta.firstPrompt.split('\n')[0]);
  if (shown) label.textContent = shown;
  dot.className = 'dot ' + state;
  dot.title = STATE_LABEL[state] || state;
  sessions.set(meta.id, {
    id: meta.id, repo, term, fit, container, li, dot, label, diffBadge, closeBtn, state,
    firstPrompt: meta.firstPrompt || '', name: meta.name || '', files: meta.files || [],
    archived: false, suspended: false, model: meta.model || '',
  });
}

// Main owns the session set and pushes the whole list whenever it changes, so a
// session created/archived/restored/deleted on a paired phone lands here and the
// desktop list follows it (and vice versa — our own changes arrive back as an echo
// that reconciles to a no-op, since the UI already matches).
function syncSessions(list) {
  if (!Array.isArray(list)) return;
  const seen = new Set();
  for (const meta of list) {
    seen.add(meta.id);
    const s = sessions.get(meta.id);
    if (!s) {
      // A running session needs a terminal to render into; a stopped one gets the
      // usual "restore me" placeholder.
      if (meta.live) adoptSession(meta);
      else restoreSessionRow(meta);
    } else if (meta.archived !== s.archived) {
      s.archived = meta.archived;
      // Main has already killed/respawned the PTY, so mirror it in the UI only.
      if (meta.archived) suspendSessionUI(s, { notifyMain: false });
      else if (s.suspended && meta.live) rebuildTerminalUI(s);
    }
    // The list carries who holds each session, so a renderer that reloaded (or a row
    // adopted mid-flight) still comes up covered if a phone is driving it.
    setControlled(sessions.get(meta.id), !!meta.controlled);
  }
  for (const id of [...sessions.keys()]) if (!seen.has(id)) removeSessionUI(id);
  applyTabFilter();
  const cur = sessions.get(activeId);
  if (!cur || !sessionVisible(cur)) selectFirstVisible();
}

// A paired phone is driving this session. Cover its terminal rather than tearing it
// down — the xterm keeps consuming pty-data underneath, so taking control back shows
// the current screen instantly instead of a blank one. The cover also swallows clicks
// and disableStdin swallows keystrokes, so the desktop can't type into a PTY someone
// else is holding.
// Forget a cover whose DOM node was already thrown away with the container's other
// children, so a later claim rebuilds it instead of assuming it's still on screen.
function clearControlled(s) {
  s.cover = null;
  s.controlled = false;
  s.li.classList.remove('controlled');
}

function setControlled(s, on) {
  if (!s || s.controlled === on) return;
  s.controlled = on;
  s.li.classList.toggle('controlled', on);
  s.container.classList.toggle('controlled', on);
  if (s.term) s.term.options.disableStdin = on;
  if (!on) {
    if (s.cover) { s.cover.remove(); s.cover = null; }
    // The PTY is still phone-sized; snap the visible terminal back to ours.
    if (s.id === activeId) fit(s);
    return;
  }
  const cover = document.createElement('div');
  cover.className = 'term-controlled-cover';
  const text = document.createElement('div');
  text.className = 'term-controlled-text';
  text.textContent = 'Controlled by mobile';
  const hint = document.createElement('div');
  hint.className = 'term-controlled-hint';
  hint.textContent = 'This session is being driven from a paired phone. Its output is hidden here.';
  const btn = document.createElement('button');
  btn.className = 'term-controlled-btn';
  btn.textContent = 'Take control';
  // Main clears the claim and echoes session-control back, which uncovers us.
  btn.onclick = () => window.api.takeSessionControl(s.id);
  cover.append(text, hint, btn);
  s.container.appendChild(cover);
  s.cover = cover;
}

window.api.onSessionControl(({ id, controlled }) => setControlled(sessions.get(id), controlled));

// Tear down a session's UI without telling main to kill it (used both for an
// explicit close and when main evicts an old session past the storage budget).
function removeSessionUI(id) {
  const s = sessions.get(id);
  if (!s) return;
  if (s.term) { if (s.renderer) s.renderer.dispose(); untrackTermTheme(s.term); s.term.dispose(); }
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
  if (s.committing) return; // a commit is already in flight for this session
  // The session is still working (yellow); its file set may be mid-change, so
  // confirm before committing a moving target.
  if (s.state === 'working' && !(await confirmDialog({
    title: 'Commit while running?',
    message: 'This session is still running. Its files may still be changing. Commit now anyway?',
    ok: 'Commit',
  }))) return;
  s.committing = true; // spinner + blocks re-clicks until the message is authored and the commit lands
  s.commitMsg = '';
  updateSessionBar();
  let r;
  try { r = await window.api.commitSession(s.id); }
  finally { s.committing = false; }
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
  if (r) { s.diffStat = { additions: r.additions, deletions: r.deletions, files: r.files }; renderCommitButton(s); renderDiffButton(s); renderRowDiff(s); }
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

document.getElementById('new-session').onclick = () => newSession();

// Per-session model picker: the split-button caret opens a dropdown listing the
// available models; choosing one spawns a session with that model (the subagent
// model keeps the saved default). The menu pops up above the button and mirrors
// the recent-folders menu's open/close handling.
const modelMenu = document.getElementById('session-model-menu');
const newSessionOptsBtn = document.getElementById('new-session-opts');
function closeModelMenu() {
  if (modelMenu.hidden) return;
  modelMenu.classList.remove('open');
  newSessionOptsBtn.setAttribute('aria-expanded', 'false');
  // Wait for the collapse animation before hiding so it actually plays.
  modelMenu.addEventListener('transitionend', () => { modelMenu.hidden = true; }, { once: true });
}
function openModelMenu() {
  const current = getSessionModel();
  modelMenu.replaceChildren();
  // Skip the inherit/default model — the plain New session button already uses it.
  for (const m of MODELS) {
    if (m.id === 'default') continue;
    const item = document.createElement('button');
    item.className = 'model-menu-item' + (m.id === current ? ' current' : '');
    item.textContent = m.name;
    item.onclick = () => { closeModelMenu(); newSession({ model: m.id }); };
    modelMenu.appendChild(item);
  }
  modelMenu.hidden = false;
  newSessionOptsBtn.setAttribute('aria-expanded', 'true');
  // Next frame so the un-hidden element transitions from the collapsed state.
  requestAnimationFrame(() => modelMenu.classList.add('open'));
}
newSessionOptsBtn.onclick = (e) => {
  e.stopPropagation();
  if (modelMenu.hidden) openModelMenu(); else closeModelMenu();
};
document.addEventListener('click', (e) => {
  if (!modelMenu.hidden && !modelMenu.contains(e.target) && !newSessionOptsBtn.contains(e.target)) closeModelMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });

for (const btn of sessionTabs.children) btn.onclick = () => setTab(btn.dataset.tab);

// Session keyboard shortcuts, in the capture phase so they win over the focused
// terminal: Shift+↓/↑ cycle to the next/previous visible session (list order,
// wrapping at both ends), and Ctrl/⌘+N opens a new session. The terminal's input
// is an xterm <textarea>, so allow the shortcuts from there (the common case);
// only bail when focus is in a real editable surface (file editor, search box).
window.addEventListener('keydown', (e) => {
  const ae = document.activeElement;
  const inTerminal = ae?.classList.contains('xterm-helper-textarea');
  const typing = !inTerminal && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae?.tagName || '')
    || ae?.isContentEditable);
  if (typing) return;

  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    newSession();
    return;
  }
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
    && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const visibleIds = [...listEl.children]
      .filter((o) => o.style.display !== 'none')
      .map((o) => o.dataset.id);
    const next = nextSessionId(visibleIds, activeId, e.key === 'ArrowDown' ? 1 : -1);
    if (!next) return;
    e.preventDefault();
    selectSession(next);
  }
}, true);

// Archived-tab search: debounced like the explorer's file search (150ms), then
// re-run the tab filter so non-matching archived rows hide. Selection is left
// alone while typing — the filter is transient and non-destructive.
let sessionSearchTimer;
sessionSearch.oninput = () => {
  clearTimeout(sessionSearchTimer);
  sessionSearchTimer = setTimeout(() => {
    archivedTerms = compileQuery(sessionSearch.value);
    applyTabFilter();
  }, 150);
};

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
  // input box, then drop in any queued message (see newSessionWithPrompt). The
  // Enter is sent as a SEPARATE write after a further delay: bundling "\r" with the
  // text submits before the TUI has finished ingesting a multi-line paste, so the
  // prompt fires half-typed. Typing first, then Enter, makes it submit reliably.
  if (pendingPrompts.has(id)) {
    const text = pendingPrompts.get(id);
    pendingPrompts.delete(id);
    setTimeout(() => window.api.sendInput(id, text), 1000);
    setTimeout(() => window.api.sendInput(id, '\r'), 1400);
  }
});
window.api.onStatus(({ id, state }) => setState(id, state));
// Clicking the OS notification asks main to raise the window; this is main
// telling the renderer which session that notification was about.
window.api.onSelectSession((id) => selectSession(id));
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
// A `/model <id>` the user typed straight into the terminal — mirror it onto the
// badge and remember it as the default for the next session.
window.api.onSessionModel(({ id, model }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.model = model;
  setSessionModel(model);
  if (id === activeId) renderModelBadge(s);
});
// Main evicted the oldest sessions to stay under the persisted-storage budget;
// drop their rows so the UI matches what survives on disk.
window.api.onSessionEvicted(({ ids }) => { for (const id of ids) removeSessionUI(id); });
window.api.onSessionsChanged(syncSessions);
// A session failed in main (saving/retrieving/committing/…). Rather than crash or
// vanish into the console, surface it as a dismissable warning with the error text.
window.api.onSessionError(({ context, message }) => {
  const detail = context ? `${t('warn.session')} (${context}):\n\n${message}` : message;
  showWarning(detail, t('warn.session'));
});
