import { t } from '../i18n/index.js';
import { openDialog } from './shared/dialog.js';

// --- worktree mode toggle (sessions pane header) ---
// Per PROJECT, not per app: it lives in main's project-settings store keyed by the
// project root, because main reads it while creating a session — before any
// renderer round-trip — and renderer localStorage is per-instance anyway.
//
// Flipping it never touches existing sessions: it only decides whether the NEXT
// session gets its own worktree. That's why the switch sits in the sessions
// header rather than the settings panel — it describes what the New Session
// button is about to do, so it belongs next to it.

const toggle = document.getElementById('worktree-toggle');
const segs = [...toggle.querySelectorAll('.wt-seg')];

let projectRoot = null;
let enabled = false;
let mode = false; // true = new sessions get their own worktree

// Why the toggle is inert, in the user's words. A project with no commit can't
// host a worktree at all (`git worktree add` can't resolve an unborn HEAD), so
// saying so is more useful than a switch that fails on first use.
const REASON_KEY = {
  'no-folder': 'worktree.needsFolder',
  'not-a-repo': 'worktree.needsRepo',
  'no-commits': 'worktree.needsCommit',
};

function paint() {
  for (const seg of segs) seg.classList.toggle('active', (seg.dataset.worktree === '1') === mode);
}

function setEnabled(on, reason) {
  enabled = on;
  toggle.classList.toggle('disabled', !on);
  for (const seg of segs) seg.disabled = !on;
  toggle.title = on ? t('worktree.toggleTitle') : t(REASON_KEY[reason] || 'worktree.needsRepo');
}

// Re-read both the support state and the stored flag for whichever project is
// open. Called on startup and on every folder change.
export async function refreshWorktreeToggle() {
  try {
    projectRoot = await window.api.getMainRepoPath();
    toggle.hidden = !projectRoot;
    if (!projectRoot) return;
    const [support, settings] = await Promise.all([
      window.api.worktreeSupport(),
      window.api.getProjectSettings(projectRoot),
    ]);
    mode = !!(settings && settings.useWorktrees);
    paint();
    setEnabled(!!(support && support.ok), support && support.reason);
  } catch (err) {
    console.error('[worktree toggle refresh]', err);
  }
}

for (const seg of segs) {
  seg.onclick = async () => {
    const want = seg.dataset.worktree === '1';
    if (!projectRoot || !enabled || want === mode) return;
    // Paint first so the segment responds to the click, then reconcile with what
    // the store actually accepted — the UI must never claim a mode main isn't in.
    mode = want;
    paint();
    try {
      const saved = await window.api.setProjectSetting({ repo: projectRoot, key: 'useWorktrees', value: want });
      mode = !!(saved && saved.useWorktrees);
    } catch (err) {
      console.error('[worktree toggle save]', err);
      mode = !want;
    }
    paint();
  };
}

// --- creating a worktree session ---
// `git worktree add` gives the new checkout every TRACKED file and nothing else.
// What makes a project actually runnable — node_modules, .env, build output — is
// untracked or ignored, so it has to be copied. That copy can be minutes and
// gigabytes, which is why it gets a pre-scan (drop what you don't need) and a
// progress dialog (see it move, and stop it).

export function isWorktreeMode() {
  return enabled && mode;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Remember what the user unchecked, per project: a developer who never wants
// node_modules copied shouldn't re-uncheck it for every session.
const skipMemory = new Map(); // project root -> string[]

// Ask which heavy directories to carry over. Returns the skip list, or null if
// the user backed out (in which case no session is created at all).
async function askSkipList() {
  const scan = await window.api.worktreePrescan();
  const rows = (scan && scan.rows) || [];
  // Nothing heavy enough to be worth a decision: copy it all, silently.
  if (!scan || !scan.ok || !rows.length) return [];

  const remembered = new Set(skipMemory.get(projectRoot) || []);
  const list = document.createElement('div');
  list.className = 'wt-scan-list';
  const boxes = rows.map((r) => {
    const row = document.createElement('label');
    row.className = 'wt-scan-row';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !remembered.has(r.path);
    box.dataset.path = r.path;
    const name = document.createElement('span');
    name.className = 'wt-scan-path';
    name.textContent = r.path;
    name.title = r.path;
    const size = document.createElement('span');
    size.className = 'wt-scan-size';
    size.textContent = `${fmtBytes(r.bytes)} · ${r.files.toLocaleString()}`;
    row.append(box, name, size);
    list.append(row);
    return box;
  });

  const chosen = await openDialog({
    title: t('worktree.scanTitle'),
    body: t('worktree.scanBody'),
    content: list,
    cancelValue: null,
    buttons: [
      { label: t('worktree.cancel'), value: null, variant: 'secondary' },
      { label: t('worktree.create'), value: () => boxes.filter((b) => !b.checked).map((b) => b.dataset.path), variant: 'primary' },
    ],
  });
  if (chosen == null) return null;
  skipMemory.set(projectRoot, chosen);
  return chosen;
}

// Progress while the copy runs. Cancel is only armed once the first progress
// event names the session id — before that there is nothing to cancel yet.
function openProgressDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'wt-progress';
  const bar = document.createElement('div');
  bar.className = 'wt-progress-bar';
  const fill = document.createElement('div');
  fill.className = 'wt-progress-fill';
  bar.append(fill);
  const line = document.createElement('div');
  line.className = 'wt-progress-line';
  line.textContent = t('worktree.copyStarting');
  const file = document.createElement('div');
  file.className = 'wt-progress-file';
  wrap.append(bar, line, file);

  let id = null;
  let closeDialog = () => {};
  const off = window.api.onWorktreeProgress((msg) => {
    id = msg.id;
    const pct = msg.totalBytes ? Math.min(100, Math.round((msg.bytes / msg.totalBytes) * 100)) : 0;
    fill.style.width = `${pct}%`;
    line.textContent = t('worktree.copyProgress')
      .replace('{done}', fmtBytes(msg.bytes))
      .replace('{total}', fmtBytes(msg.totalBytes))
      .replace('{files}', String(msg.files))
      .replace('{totalFiles}', String(msg.totalFiles));
    file.textContent = msg.current || '';
  });

  openDialog({
    title: t('worktree.copyTitle'),
    content: wrap,
    dismissible: false, // a half-copied tree must not be left behind by an Esc
    buttons: [{ label: t('worktree.cancel'), value: 'cancel', variant: 'danger' }],
    onOpen: (api) => { closeDialog = api.close; },
  }).then((v) => { if (v === 'cancel' && id) window.api.worktreeCancel(id); });

  return () => { off?.(); closeDialog('done'); };
}

// The whole pre-session flow: ask what to skip, then show progress while main
// builds the tree. Returns { skip } to pass to new-session, or null to abort.
export async function prepareWorktree() {
  const skip = await askSkipList();
  if (skip == null) return null;
  return { skip, done: openProgressDialog() };
}

// --- the active-tree chip (explorer header) ---
// Focus-follow means selecting a session moves the git pane, file tree and run
// toolbar onto its worktree. Getting back to the project used to require
// selecting a main-tree session, which is not something the user should have to
// create one for. The chip is that way back: it appears only while the panels
// are on a worktree, names it, and clicking it returns to the project. The
// session stays selected and running -- only the panels move -- and re-selecting
// it points them at the worktree again.

// Last path segment, either separator (worktree paths come from main, so they
// carry the host's separator).
const basename = (p) => p.split('/').pop().split('\\').pop();

const scope = document.getElementById('tree-scope');
const scopeName = document.getElementById('tree-scope-name');

export function setTreeScope(worktree, label) {
  if (!scope) return;
  scope.hidden = !worktree;
  if (worktree) scopeName.textContent = label || basename(worktree);
}

// No-op unless the panels are actually on a worktree, so the two entry points
// below can be wired unconditionally.
function backToMain() {
  if (!scope || scope.hidden) return;
  window.api.focusMainRepo().catch((err) => console.error('[focus main repo]', err));
}

if (scope) scope.onclick = backToMain;

// The blank area under the last session row is the same gesture as clicking
// empty space in a file list: "nothing in particular". Here that reads as the
// project itself, so it goes back to the main tree. Only clicks on the list's
// own padding count -- anything inside a row is that row's business. The
// selected session keeps running and stays selected; only the panels move.
const sessionList = document.getElementById('session-list');
if (sessionList) {
  sessionList.addEventListener('click', (e) => {
    if (e.target === sessionList) backToMain();
  });
}
