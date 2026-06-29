// Renderer entry point. Importing each feature module runs its wiring as a side
// effect (DOM event handlers, IPC listeners); this file then registers the
// cross-module hand-offs and kicks off the initial loads.
import './shared/bootstrap.js';
import { onClose } from './viewer/center.js';
import { showActiveSession, restoreSessions, setSessionsRepo, newSession } from './sessions.js';
import { refreshGit } from './git-pane.js';
import { refreshTree } from './explorer/tree.js';
import './explorer/search.js';
import './terminal-links.js';
import { open as openQuickOpen } from './quick-open.js';
import { registerCommands } from './command-palette.js';
import { loadToolbar } from './toolbar.js';
import { initConsoles } from './consoles.js';
import { initClaudeSetup } from './claude-setup.js';
import { initSettings, cycleTheme } from './settings.js';
import { initUsageMeter } from './usage-meter.js';
import { initPanels } from './panels.js';
import { initOnboarding, activateOnboarding, startTour, openCheatSheet } from './onboarding/index.js';
import { onClaudeReady } from './claude-setup.js';
import { t } from '../i18n/index.js';
import './panes.js';

// Closing a center overlay returns to the active session (sessions owns it).
onClose(showActiveSession);

// Open folder: a reverse-combobox that pops up the recent projects (most recent
// first) plus a "Browse…" entry, then re-points the repo and reloads everything
// that depends on it.
const openFolderBtn = document.getElementById('open-folder');
const recentMenu = document.getElementById('recent-folders-menu');

function applyRepoChange(r) {
  if (r.error) { console.error('open-folder:', r.error); return; }
  if (!r.canceled) { window.api.setWindowTitle(r.repo); setSessionsRepo(r.repo); refreshGit(); refreshTree(); loadToolbar(); }
}

async function browseForFolder() {
  try { applyRepoChange(await window.api.openFolder()); }
  catch (err) { console.error('open-folder click failed:', err); }
}

async function openRecentFolder(dir) {
  try { applyRepoChange(await window.api.openFolderPath(dir)); }
  catch (err) { console.error('open-folder-path failed:', err); }
}

function baseName(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function closeRecentMenu() {
  if (recentMenu.hidden) return;
  recentMenu.classList.remove('open');
  openFolderBtn.setAttribute('aria-expanded', 'false');
  // Wait for the collapse animation before hiding so it actually plays.
  recentMenu.addEventListener('transitionend', () => { recentMenu.hidden = true; }, { once: true });
}

async function openRecentMenu() {
  const current = await window.api.getRepoPath();
  let recents = [];
  try { recents = await window.api.getRecentFolders(); } catch {}

  recentMenu.replaceChildren();
  for (const dir of recents) {
    const item = document.createElement('button');
    item.className = 'recent-item' + (dir === current ? ' current' : '');
    item.title = dir;
    const name = document.createElement('span');
    name.className = 'recent-item-name';
    name.textContent = baseName(dir);
    const path = document.createElement('span');
    path.className = 'recent-item-path';
    path.textContent = dir;
    item.append(name, path);
    item.onclick = () => { closeRecentMenu(); openRecentFolder(dir); };
    recentMenu.appendChild(item);
  }

  const browse = document.createElement('button');
  browse.className = 'recent-item recent-browse';
  browse.textContent = t('explorer.browseFolder');
  browse.onclick = () => { closeRecentMenu(); browseForFolder(); };
  recentMenu.appendChild(browse);

  recentMenu.hidden = false;
  openFolderBtn.setAttribute('aria-expanded', 'true');
  // Next frame so the un-hidden element transitions from the collapsed state.
  requestAnimationFrame(() => recentMenu.classList.add('open'));
}

// Welcome screen (empty center) actions mirror the primary entry points.
document.getElementById('welcome-new').onclick = newSession;
document.getElementById('welcome-goto').onclick = openQuickOpen;
document.getElementById('welcome-open').onclick = browseForFolder;
document.getElementById('welcome-shortcuts').onclick = openCheatSheet;

openFolderBtn.onclick = (e) => {
  e.stopPropagation();
  if (recentMenu.hidden) openRecentMenu(); else closeRecentMenu();
};
document.addEventListener('click', (e) => {
  if (!recentMenu.hidden && !recentMenu.contains(e.target) && e.target !== openFolderBtn && !openFolderBtn.contains(e.target)) closeRecentMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeRecentMenu(); });

// Ctrl/⌘+O (with or without Shift) opens the folder picker from anywhere.
// Capture phase so a focused xterm terminal can't swallow it first, mirroring
// quick-open's Ctrl+P.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'o' || e.key === 'O')) {
    e.preventDefault();
    e.stopPropagation();
    browseForFolder();
  }
}, true);

// Command Palette (Ctrl/Cmd+Shift+P) actions. Registered here because this is
// where every action function is in scope; titles/keywords are i18n keys so the
// palette re-localizes them each time it opens.
registerCommands([
  { id: 'new-session', titleKey: 'command.newSession', keywordsKey: 'command.newSession.kw', run: newSession },
  { id: 'go-to-file', titleKey: 'command.goToFile', keywordsKey: 'command.goToFile.kw', run: openQuickOpen },
  { id: 'open-folder', titleKey: 'command.openFolder', keywordsKey: 'command.openFolder.kw', run: browseForFolder },
  { id: 'open-settings', titleKey: 'command.openSettings', keywordsKey: 'command.openSettings.kw', run: () => document.getElementById('settings-btn').click() },
  { id: 'cycle-theme', titleKey: 'command.cycleTheme', keywordsKey: 'command.cycleTheme.kw', run: cycleTheme },
  { id: 'refresh-git', titleKey: 'command.refreshGit', keywordsKey: 'command.refreshGit.kw', run: refreshGit },
  { id: 'refresh-tree', titleKey: 'command.refreshTree', keywordsKey: 'command.refreshTree.kw', run: refreshTree },
  { id: 'guided-tour', titleKey: 'command.guidedTour', keywordsKey: 'command.guidedTour.kw', run: startTour },
  { id: 'keyboard-shortcuts', titleKey: 'command.keyboardShortcuts', keywordsKey: 'command.keyboardShortcuts.kw', run: openCheatSheet },
]);

initSettings();
// Toolbar meter for the user's remaining Claude subscription usage (after
// initSettings so its labels are translated).
initUsageMeter();
initPanels();
initConsoles();
// On every launch, detect whether the Claude Code CLI is installed and, if not,
// guide the user through installing it (runs after initSettings so the dialog's
// strings are translated, and after initConsoles so "Run in terminal" has a tab).
initClaudeSetup();
restoreSessions();
refreshGit();
refreshTree();
loadToolbar();
// First-time onboarding. The help/cheat sheet wires up immediately; the
// automatic guided tour and contextual hints wait until Claude Code is confirmed
// installed (past the setup gate) so a new user isn't onboarded mid-install, and
// the tour only auto-runs when a project is open so its steps point at real UI.
initOnboarding();
onClaudeReady(() => {
  window.api.getRepoPath()
    .then((repo) => activateOnboarding({ hasRepo: !!repo }))
    .catch(() => activateOnboarding({}));
});
// ponytail: poll while focused; a file watcher would be more code for no real gain
setInterval(() => { if (document.hasFocus()) refreshGit(); }, 3000);
// Refresh the moment the window regains focus too, so changes made while the app
// was in the background (an external editor, a terminal console) show without
// waiting for the next poll tick. (Session-driven changes refresh on session-meta.)
window.addEventListener('focus', () => refreshGit());
