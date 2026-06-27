// Claude Code availability gate.
//
// This IDE is a front-end for the `claude` CLI — without it no session can spawn.
// On EVERY startup (not just the first run — nothing is persisted to skip it) we
// ask main whether `claude` is installed (check-claude); if it isn't, we open a
// guided dialog with the platform-specific install command (copy it, or run it
// straight into a built-in terminal), an npm fallback, the login step, and a
// "Recheck" button. newSession() also routes through ensureClaude(), so any
// attempt to open a session re-runs the check and re-shows the guide until Claude
// Code is actually present. See docs/architecture.md "Claude Code setup gate".
import { t } from '../i18n/index.js';
import { runSpecInConsole } from './consoles.js';

let claudeReady = false;   // unknown until the first check; gates newSession
let guide = null;          // { platform, native:{command}, npm:{command}, docsUrl, run }

const dialog = document.getElementById('claude-setup-dialog');
const osEl = document.getElementById('claude-setup-os');
const nativeBox = document.getElementById('setup-cmd-native');
const npmBox = document.getElementById('setup-cmd-npm');
const docsLink = document.getElementById('setup-docs');
const restartNote = document.getElementById('setup-restart-note');
const statusEl = document.getElementById('setup-status');
const recheckBtn = document.getElementById('claude-setup-recheck');

const OS_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

// One command row: the command text (selectable), a Copy button, and — for the
// install commands — a "Run in terminal" button that drops it into a console tab.
function commandRow(command, { runnable = true } = {}) {
  const row = document.createElement('div');
  row.className = 'setup-cmd-row';

  const code = document.createElement('code');
  code.className = 'setup-cmd-text';
  code.textContent = command;

  const actions = document.createElement('div');
  actions.className = 'setup-cmd-actions';

  const copy = document.createElement('button');
  copy.className = 'setup-cmd-btn';
  copy.textContent = t('setup.copy');
  copy.onclick = async () => {
    try { await window.api.clipboardWrite(command); } catch { return; }
    copy.textContent = t('setup.copied');
    setTimeout(() => { copy.textContent = t('setup.copy'); }, 1500);
  };
  actions.appendChild(copy);

  if (runnable) {
    const run = document.createElement('button');
    run.className = 'setup-cmd-btn setup-cmd-run';
    run.textContent = t('setup.runInTerminal');
    run.onclick = () => {
      // Run the installer in a built-in terminal tab, then drop the modal so the
      // user can watch it; the next session attempt re-checks via ensureClaude().
      runSpecInConsole({ name: 'Install Claude Code', command, kind: 'config' });
      dialog.close();
    };
    actions.appendChild(run);
  }

  row.append(code, actions);
  return row;
}

// Fill the dialog from the latest guide + check result. Idempotent.
function renderGuide() {
  if (!guide) return;
  osEl.textContent = t('setup.detected').replace('{os}', OS_LABEL[guide.platform] || guide.platform);
  nativeBox.replaceChildren(commandRow(guide.native.command));
  npmBox.replaceChildren(commandRow(guide.npm.command));
}

// Open the setup docs in the system browser (never navigate the app window).
docsLink.onclick = (e) => {
  e.preventDefault();
  if (guide) window.api.openExternal(guide.docsUrl);
};

function openSetup() {
  renderGuide();
  statusEl.textContent = '';
  statusEl.className = 'setup-status';
  restartNote.hidden = true;
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
// missing, open the guide immediately.
export async function initClaudeSetup() {
  await probe();
  if (!claudeReady) openSetup();
}

// Gate used by newSession(): re-probe (the user may have just installed it), and
// if it's still missing show the guide and report false so the caller bails out.
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
