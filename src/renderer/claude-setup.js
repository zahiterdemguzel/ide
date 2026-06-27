// Claude Code availability gate — a step-by-step setup wizard.
//
// This IDE is a front-end for the `claude` CLI; without it no session can spawn.
// On EVERY startup (nothing is persisted to skip it) we ask main whether `claude`
// is installed (check-claude). If it isn't, we open a three-step wizard:
//   1. Install — copy a platform-specific command, or "Run in terminal" to install
//      right here in an embedded terminal.
//   2. Sign in — that same terminal auto-launches `claude` once the install
//      succeeds, so the login flow runs inline.
//   3. Done — Recheck; on success the wizard closes and sessions are unblocked.
// newSession() also routes through ensureClaude(), so any attempt to open a session
// re-runs the check and re-shows the wizard until Claude Code is present.
// See docs/architecture.md "Claude Code setup gate".
import { t } from '../i18n/index.js';
import {
  Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme,
} from './shared/terminal.js';
import { registerTerminalLinks } from './terminal-links.js';

let claudeReady = false;   // unknown until the first check; gates newSession
let guide = null;          // { platform, native, npm, docsUrl, run }
let step = 0;              // current wizard step (0 install, 1 sign in, 2 done)

// Embedded terminal state (built lazily on the first "Run in terminal").
let term = null;
let termFit = null;
let termId = null;

const dialog = document.getElementById('claude-setup-dialog');
const stepsEl = document.getElementById('setup-steps');
const panes = [...dialog.querySelectorAll('.setup-pane')];
const osEl = document.getElementById('claude-setup-os');
const nativeBox = document.getElementById('setup-cmd-native');
const npmBox = document.getElementById('setup-cmd-npm');
const npmStep = document.getElementById('setup-npm-step');
const docsLink = document.getElementById('setup-docs');
const restartNote = document.getElementById('setup-restart-note');
const statusEl = document.getElementById('setup-status');
const backBtn = document.getElementById('setup-back');
const nextBtn = document.getElementById('setup-next');
const recheckBtn = document.getElementById('claude-setup-recheck');
const termView = document.getElementById('setup-term-view');
const termHost = document.getElementById('setup-term-host');

const LAST_STEP = 2;
const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

// One command row: the command text (selectable), a Copy button, and a "Run in
// terminal" button that installs in the embedded terminal. Copy yields the plain
// install line; Run uses terminalCommand (install + auto-launch claude for auth).
function commandRow(option) {
  const row = document.createElement('div');
  row.className = 'setup-cmd-row';

  const code = document.createElement('code');
  code.className = 'setup-cmd-text';
  code.textContent = option.command;

  const actions = document.createElement('div');
  actions.className = 'setup-cmd-actions';

  const copy = document.createElement('button');
  copy.className = 'setup-cmd-btn';
  copy.textContent = t('setup.copy');
  copy.onclick = async () => {
    try { await window.api.clipboardWrite(option.command); } catch { return; }
    copy.textContent = t('setup.copied');
    setTimeout(() => { copy.textContent = t('setup.copy'); }, 1500);
  };

  const run = document.createElement('button');
  run.className = 'setup-cmd-btn setup-cmd-run';
  run.textContent = t('setup.runInTerminal');
  run.onclick = () => startInstall(option.terminalCommand);

  actions.append(copy, run);
  row.append(code, actions);
  return row;
}

// Fill the install step from the latest guide. Idempotent.
function renderGuide() {
  if (!guide) return;
  osEl.textContent = t('setup.detected').replace('{os}', OS_LABEL[guide.platform] || guide.platform);
  nativeBox.replaceChildren(commandRow(guide.native));
  if (guide.npm) { npmStep.hidden = false; npmBox.replaceChildren(commandRow(guide.npm)); }
  else { npmStep.hidden = true; npmBox.replaceChildren(); }
}

// Open the setup docs in the system browser (never navigate the app window).
docsLink.onclick = (e) => {
  e.preventDefault();
  if (guide) window.api.openExternal(guide.docsUrl);
};

// --- wizard navigation ---------------------------------------------------------
function go(to) {
  step = Math.max(0, Math.min(LAST_STEP, to));
  panes.forEach((p) => { p.hidden = Number(p.dataset.pane) !== step; });
  for (const item of stepsEl.children) {
    const i = Number(item.dataset.step);
    item.classList.toggle('active', i === step);
    item.classList.toggle('done', i < step);
  }
  backBtn.hidden = step === 0;
  nextBtn.hidden = step === LAST_STEP;
  recheckBtn.hidden = step !== LAST_STEP;
  statusEl.textContent = '';
  statusEl.className = 'setup-status';
  if (step === LAST_STEP) restartNote.hidden = true;
}

backBtn.onclick = () => go(step - 1);
nextBtn.onclick = () => go(step + 1);

// --- embedded terminal ---------------------------------------------------------
function buildTerminal() {
  term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  termFit = new FitAddon();
  term.loadAddon(termFit);
  term.open(termHost);
  attachClipboard(term);
  registerTerminalLinks(term);
}

function fitTerminal() {
  if (!term || !termFit) return;
  try { termFit.fit(); window.api.termResize(termId, term.cols, term.rows); } catch { /* hidden */ }
}

function teardownTerminal() {
  if (termId) { window.api.termKill(termId); termId = null; }
  if (term) { untrackTermTheme(term); term.dispose(); term = null; termFit = null; }
  termView.hidden = true;
  termHost.replaceChildren();
}

// Install in the embedded terminal: reveal it, (re)spawn a shell running the
// install+auth command, then advance the wizard to the Sign in step.
async function startInstall(command) {
  teardownTerminal();
  termView.hidden = false;
  buildTerminal();
  // The view just un-hid; fit on the next frame so the host has real dimensions.
  requestAnimationFrame(fitTerminal);
  let res;
  try { res = await window.api.termCreate({ cols: term.cols || 80, rows: term.rows || 24, command }); }
  catch { return; }
  termId = res.id;
  term.onData((d) => window.api.termInput(termId, d));
  go(1);
  requestAnimationFrame(fitTerminal);
  term.focus();
}

// term-data / term-exit are broadcast to every listener; ours filters by termId
// (the git-pane consoles' listeners ignore ids they don't own, and vice-versa).
window.api.onTermData(({ id, data }) => { if (id === termId && term) term.write(data); });
window.api.onTermExit(({ id }) => { if (id === termId) termId = null; });
window.addEventListener('resize', () => { if (!termView.hidden) fitTerminal(); });

// --- check + lifecycle ---------------------------------------------------------
function openSetup() {
  resetToStart();
  renderGuide();
  if (!dialog.open) dialog.showModal();
}

// Reset wizard chrome to step 1 with no terminal — for a fresh open.
function resetToStart() {
  teardownTerminal();
  go(0);
}

// Ask main whether Claude Code is installed; cache the result + guide.
async function probe() {
  let res;
  try { res = await window.api.checkClaude(); }
  catch { return false; }
  claudeReady = !!res.installed;
  if (res.guide) guide = res.guide;
  return claudeReady;
}

// Runs on every app launch (wired unconditionally in index.js): if Claude Code is
// missing, open the wizard immediately.
export async function initClaudeSetup() {
  await probe();
  if (!claudeReady) openSetup();
}

// Gate used by newSession(): re-probe (the user may have just installed it), and
// if it's still missing show the wizard and report false so the caller bails out.
export async function ensureClaude() {
  if (claudeReady) return true;
  await probe();
  if (!claudeReady) openSetup();
  return claudeReady;
}

recheckBtn.onclick = async () => {
  recheckBtn.disabled = true;
  statusEl.textContent = t('setup.checking');
  statusEl.className = 'setup-status';
  const ok = await probe();
  recheckBtn.disabled = false;
  if (ok) {
    statusEl.textContent = t('setup.found');
    statusEl.className = 'setup-status ok';
    setTimeout(() => { if (dialog.open) dialog.close(); }, 900);
  } else {
    // A just-installed CLI often isn't on the already-running app's PATH until a
    // restart, so point the user there when the recheck still comes up empty.
    statusEl.textContent = t('setup.notFound');
    statusEl.className = 'setup-status err';
    restartNote.hidden = false;
  }
};

document.getElementById('claude-setup-close').onclick = () => dialog.close();
// Always tear the terminal down when the dialog closes (×, Esc, or success), so a
// background install isn't left running and the next open starts clean.
dialog.addEventListener('close', teardownTerminal);
