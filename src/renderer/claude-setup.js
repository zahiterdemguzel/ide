// Claude Code availability gate — a linear 3-page setup wizard.
//
// This IDE is a front-end for the `claude` CLI; without it no session can spawn.
// On EVERY startup (nothing is persisted to skip it) we ask main whether `claude`
// is installed (check-claude). If it isn't, we walk the user through three pages:
//   1. Intro    — "Claude Code isn't installed. Click Next to install it."
//   2. Installing — a terminal runs the native installer; Next enables once the
//      install shell exits (the command ends with `exit`, watched via term-exit).
//   3. Sign in  — that terminal is torn down and a fresh one auto-runs `claude`
//      for the login flow; Finish enables once auth is detected (we poll
//      check-claude-auth, which reads the credentials file).
// newSession() also routes through ensureClaude(), so any attempt to open a session
// re-runs the check and re-shows the wizard until Claude Code is present.
// See docs/architecture.md "Claude Code setup gate".
import { t } from '../i18n/index.js';
import {
  Terminal, FitAddon, termTheme, attachClipboard, trackTermTheme, untrackTermTheme,
} from './shared/terminal.js';
import { registerTerminalLinks } from './terminal-links.js';

let claudeReady = false;   // unknown until the first check; gates newSession
let guide = null;          // { platform, install, installTerminal, auth, docsUrl, run }
let step = 0;              // 0 intro · 1 installing · 2 sign in

// Embedded terminal state (one alive at a time).
let term = null;
let termFit = null;
let termId = null;
let exitHandler = null;    // called with exitCode when the active terminal exits
let authTimer = null;      // poll handle for the sign-in step

const dialog = document.getElementById('claude-setup-dialog');
const stepsEl = document.getElementById('setup-steps');
const panes = [...dialog.querySelectorAll('.setup-pane')];
const osEl = document.getElementById('claude-setup-os');
const installHost = document.getElementById('setup-install-host');
const authHost = document.getElementById('setup-auth-host');
const docsLink = document.getElementById('setup-docs');
const restartNote = document.getElementById('setup-restart-note');
const statusEl = document.getElementById('setup-status');
const backBtn = document.getElementById('setup-back');
const nextBtn = document.getElementById('setup-next');
const finishBtn = document.getElementById('setup-finish');

const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

function setStatus(text, kind = '') {
  statusEl.textContent = text || '';
  statusEl.className = 'setup-status' + (kind ? ' ' + kind : '');
}

// --- wizard navigation ---------------------------------------------------------
// go() only paints chrome; the goto* helpers below own the side effects (starting
// terminals), so navigation can't recurse.
function go(to) {
  step = to;
  panes.forEach((p) => { p.hidden = Number(p.dataset.pane) !== step; });
  for (const item of stepsEl.children) {
    const i = Number(item.dataset.step);
    item.classList.toggle('active', i === step);
    item.classList.toggle('done', i < step);
  }
  backBtn.hidden = step === 0;
  nextBtn.hidden = step === 2;
  finishBtn.hidden = step !== 2;
  setStatus('');
  restartNote.hidden = true;
}

function gotoIntro() {
  teardownTerminal();
  go(0);
  if (guide) osEl.textContent = t('setup.detected').replace('{os}', OS_LABEL[guide.platform] || guide.platform);
}

function gotoInstalling() {
  teardownTerminal();
  go(1);
  nextBtn.disabled = true;           // until the installer finishes
  setStatus(t('setup.installing'));
  runInTerminal(installHost, guide.installTerminal, (exitCode) => {
    nextBtn.disabled = false;
    if (exitCode === 0 || exitCode === null) setStatus(t('setup.installDone'), 'ok');
    else setStatus(t('setup.installFailed'), 'err');
  });
}

function gotoSignin() {
  teardownTerminal();
  go(2);
  finishBtn.disabled = true;         // until auth is detected
  setStatus(t('setup.authWaiting'));
  runInTerminal(authHost, guide.auth, null);
  startAuthPoll();
}

backBtn.onclick = () => { if (step === 2) gotoInstalling(); else gotoIntro(); };
nextBtn.onclick = () => { if (step === 0) gotoInstalling(); else if (step === 1) gotoSignin(); };
finishBtn.onclick = () => finish();

async function finish() {
  await probe();             // refresh install state for the session gate
  if (dialog.open) dialog.close();
}

// --- embedded terminal ---------------------------------------------------------
// Build an xterm into `host`, spawn a shell running `command`, and call onExit with
// the shell's exit code when it terminates.
async function runInTerminal(host, command, onExit) {
  term = new Terminal({ fontSize: 11, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  trackTermTheme(term);
  termFit = new FitAddon();
  term.loadAddon(termFit);
  term.open(host);
  attachClipboard(term);
  registerTerminalLinks(term);
  requestAnimationFrame(fitTerminal); // host just became visible — fit next frame
  exitHandler = onExit;
  let res;
  try { res = await window.api.termCreate({ cols: term.cols || 80, rows: term.rows || 24, command }); }
  catch { return; }
  termId = res.id;
  term.onData((d) => window.api.termInput(termId, d));
  requestAnimationFrame(fitTerminal);
  term.focus();
}

function fitTerminal() {
  if (!term || !termFit) return;
  try { termFit.fit(); window.api.termResize(termId, term.cols, term.rows); } catch { /* hidden */ }
}

function teardownTerminal() {
  stopAuthPoll();
  exitHandler = null;
  if (termId) { window.api.termKill(termId); termId = null; }
  if (term) { untrackTermTheme(term); term.dispose(); term = null; termFit = null; }
  installHost.replaceChildren();
  authHost.replaceChildren();
}

// term-data / term-exit are broadcast to every listener; ours filters by termId
// (the git-pane consoles' listeners ignore ids they don't own, and vice-versa).
window.api.onTermData(({ id, data }) => { if (id === termId && term) term.write(data); });
window.api.onTermExit(({ id, exitCode }) => {
  if (id !== termId) return; // a different terminal, or one we already tore down
  termId = null;
  const h = exitHandler; exitHandler = null;
  if (h) h(typeof exitCode === 'number' ? exitCode : null);
});
window.addEventListener('resize', () => { if (term) fitTerminal(); });

// --- sign-in detection ---------------------------------------------------------
function stopAuthPoll() { if (authTimer) { clearInterval(authTimer); authTimer = null; } }

function startAuthPoll() {
  stopAuthPoll();
  const check = async () => {
    let res;
    try { res = await window.api.checkClaudeAuth(); } catch { return; }
    if (res && res.authed) {
      stopAuthPoll();
      finishBtn.disabled = false;
      setStatus(t('setup.authDone'), 'ok');
    }
  };
  check();                       // in case the user is already signed in
  authTimer = setInterval(check, 2000);
}

// Open the setup docs in the system browser (never navigate the app window).
docsLink.onclick = (e) => { e.preventDefault(); if (guide) window.api.openExternal(guide.docsUrl); };

// --- check + lifecycle ---------------------------------------------------------
function openSetup() {
  gotoIntro();
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

document.getElementById('claude-setup-close').onclick = () => dialog.close();
// Always tear the terminal + poll down when the dialog closes (×, Esc, Finish), so
// no background install/auth shell is left running and the next open starts clean.
dialog.addEventListener('close', teardownTerminal);
