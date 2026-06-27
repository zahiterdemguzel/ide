// Claude Code availability gate — a simple, three-step setup wizard.
//
// This IDE is a front-end for the `claude` CLI; without it no session can spawn.
// On EVERY startup (nothing is persisted to skip it) we ask main whether `claude`
// is installed (check-claude). If it isn't, we open the wizard:
//   1. Intro    — "you don't have Claude Code; click Next to install it".
//   2. Install  — an embedded terminal runs the install command automatically;
//                 Next stays disabled until the install reports completion.
//   3. Sign in  — the install terminal is torn down and a fresh one launches
//                 `claude` (already entered) so the auth flow runs inline; the user
//                 finishes auth there and clicks Finish.
// Finish verifies with a real `claude` probe before closing. newSession() also routes
// through ensureClaude(), so any attempt to open a session re-runs the check and
// re-shows the wizard until Claude Code is present.
// See docs/architecture.md "Claude Code setup gate".
import { t } from '../i18n/index.js';
import {
  Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme,
} from './shared/terminal.js';
import { registerTerminalLinks } from './terminal-links.js';

let claudeReady = false;   // unknown until the first check; gates newSession
let guide = null;          // { platform, install, auth, installDone, docsUrl, run }
let step = 0;              // 0 intro, 1 installing, 2 sign in
let installDone = false;   // install command finished (its marker was seen)
let watchInstall = false;  // are we watching the terminal output for that marker?
let outBuf = '';           // rolling buffer of terminal output, scanned for the marker

// Embedded terminal state (rebuilt for the install step, then the sign-in step).
let term = null;
let termFit = null;
let termId = null;

const dialog = document.getElementById('claude-setup-dialog');
const stepsEl = document.getElementById('setup-steps');
const panes = [...dialog.querySelectorAll('.setup-pane')];
const osEl = document.getElementById('claude-setup-os');
const docsLink = document.getElementById('setup-docs');
const restartNote = document.getElementById('setup-restart-note');
const statusEl = document.getElementById('setup-status');
const backBtn = document.getElementById('setup-back');
const nextBtn = document.getElementById('setup-next');
const finishBtn = document.getElementById('claude-setup-finish');
const termView = document.getElementById('setup-term-view');
const termHost = document.getElementById('setup-term-host');

const LAST_STEP = 2;
const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function renderOs() {
  if (!guide || !osEl) return;
  osEl.textContent = t('setup.detected').replace('{os}', OS_LABEL[guide.platform] || guide.platform);
}

// Open the setup docs in the system browser (never navigate the app window).
docsLink.onclick = (e) => {
  e.preventDefault();
  if (guide) window.api.openExternal(guide.docsUrl);
};

// --- wizard navigation ---------------------------------------------------------
// Paint the chrome for `step`: panes, stepper, footer buttons. Terminal lifecycle
// is handled by goStep() so this stays a pure view update.
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
  finishBtn.hidden = step !== LAST_STEP;
  // On the install step Next waits for the install to finish; elsewhere it's free.
  nextBtn.disabled = step === 1 && !installDone;
  statusEl.textContent = '';
  statusEl.className = 'setup-status';
  if (step === LAST_STEP) restartNote.hidden = true;
}

// Move to a step, owning the embedded terminal: any previous terminal is always torn
// down first, then the install / sign-in step spawns its own.
function goStep(target) {
  teardownTerminal();
  installDone = false;
  const next = Math.max(0, Math.min(LAST_STEP, target));
  if (next === 0) { go(0); return; }
  go(next);
  startTerminal(next === 1 ? guide.install : guide.auth, next === 1);
}

backBtn.onclick = () => goStep(step - 1);
nextBtn.onclick = () => goStep(step + 1);

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
  watchInstall = false;
  outBuf = '';
  if (termId) { window.api.termKill(termId); termId = null; }
  if (term) { untrackTermTheme(term); term.dispose(); term = null; termFit = null; }
  termView.hidden = true;
  termHost.replaceChildren();
}

// Reveal the terminal and spawn a shell running `command`. When `watch` is set we
// scan its output for the install-completion marker to enable Next (the install step).
async function startTerminal(command, watch) {
  termView.hidden = false;
  buildTerminal();
  watchInstall = watch;
  outBuf = '';
  // The view just un-hid; fit on the next frame so the host has real dimensions.
  requestAnimationFrame(fitTerminal);
  let res;
  try { res = await window.api.termCreate({ cols: term.cols || 80, rows: term.rows || 24, command }); }
  catch { return; }
  termId = res.id;
  term.onData((d) => window.api.termInput(termId, d));
  requestAnimationFrame(fitTerminal);
  term.focus();
}

// term-data / term-exit are broadcast to every listener; ours filters by termId
// (the git-pane consoles' listeners ignore ids they don't own, and vice-versa).
window.api.onTermData(({ id, data }) => {
  if (id !== termId || !term) return;
  term.write(data);
  if (!watchInstall || installDone) return;
  outBuf += data;
  if (outBuf.includes(guide.installDone)) {
    installDone = true;
    watchInstall = false;
    if (step === 1) nextBtn.disabled = false;
  } else if (outBuf.length > 8000) {
    outBuf = outBuf.slice(-2000); // keep the buffer bounded on long installs
  }
});
window.api.onTermExit(({ id }) => { if (id === termId) termId = null; });
window.addEventListener('resize', () => { if (!termView.hidden) fitTerminal(); });

// --- check + lifecycle ---------------------------------------------------------
function openSetup() {
  renderOs();
  goStep(0);
  if (!dialog.open) dialog.showModal();
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

// Finish verifies with a real probe — the source of truth that the CLI is present —
// before closing. A just-installed CLI often isn't on the already-running app's PATH
// until a restart, so point the user there when the probe still comes up empty.
finishBtn.onclick = async () => {
  finishBtn.disabled = true;
  statusEl.textContent = t('setup.checking');
  statusEl.className = 'setup-status';
  const ok = await probe();
  finishBtn.disabled = false;
  if (ok) {
    statusEl.textContent = t('setup.found');
    statusEl.className = 'setup-status ok';
    setTimeout(() => { if (dialog.open) dialog.close(); }, 700);
  } else {
    statusEl.textContent = t('setup.notFound');
    statusEl.className = 'setup-status err';
    restartNote.hidden = false;
  }
};

document.getElementById('claude-setup-close').onclick = () => dialog.close();
// Always tear the terminal down when the dialog closes (×, Esc, or success), so a
// background install isn't left running and the next open starts clean.
dialog.addEventListener('close', teardownTerminal);
