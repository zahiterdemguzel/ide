// Renderer entry point. Importing each feature module runs its wiring as a side
// effect (DOM event handlers, IPC listeners); this file then registers the
// cross-module hand-offs and kicks off the initial loads.
import './shared/bootstrap.js';
import { onClose } from './viewer/center.js';
import { showActiveSession, restoreSessions, setSessionsRepo, newSession } from './sessions.js';
import { refreshGit, autoFetch } from './git-pane.js';
import { refreshTree } from './explorer/tree.js';
import './explorer/search.js';
import './terminal-links.js';
import { open as openQuickOpen } from './quick-open.js';
import { registerCommands } from './command-palette.js';
import { loadToolbar } from './toolbar.js';
import { initConsoles, resetConsoles } from './consoles.js';
import { initClaudeSetup } from './claude-setup.js';
import { initSettings, cycleTheme } from './settings.js';
import { initRemotePane } from './remote-pane.js';
import { initUsageMeter } from './usage-meter.js';
import { initPanels } from './panels.js';
import { initOnboarding, activateOnboarding, startTour, openCheatSheet } from './onboarding/index.js';
import { onClaudeReady } from './claude-setup.js';
import { showArmHint, hideArmHint } from './shared/arm-hint.js';
import { t } from '../i18n/index.js';
import './panes.js';

const TRASH_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>';

// Closing a center overlay returns to the active session (sessions owns it).
onClose(showActiveSession);

// Open folder: a reverse-combobox that pops up the recent projects (most recent
// first) plus a "Browse…" entry, then re-points the repo and reloads everything
// that depends on it.
const openFolderBtn = document.getElementById('open-folder');
const recentMenu = document.getElementById('recent-folders-menu');

function applyRepoChange(r) {
  if (r.error) { console.error('open-folder:', r.error); return; }
  if (!r.canceled) { window.api.setWindowTitle(r.repo); setSessionsRepo(r.repo); resetConsoles(); refreshGit(); refreshTree(); loadToolbar(); autoFetch(); }
}

async function browseForFolder() {
  try { applyRepoChange(await window.api.openFolder()); }
  catch (err) { console.error('open-folder click failed:', err); }
}

async function openRecentFolder(dir) {
  try { applyRepoChange(await window.api.openFolderPath(dir)); }
  catch (err) { console.error('open-folder-path failed:', err); }
}

// The macOS Dock menu switches the folder in main directly; reload the UI to match.
window.api.onFolderChanged((msg) => applyRepoChange({ canceled: false, repo: msg.repo }));

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
    const row = document.createElement('div');
    row.className = 'recent-row';

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

    // Forgetting a project can't be undone, so it arms on the first click and
    // only removes on the second — the same two-click pattern as the session
    // delete button. Removal keeps the menu open so several can be pruned in a row.
    const del = document.createElement('button');
    del.className = 'recent-delete';
    del.title = t('explorer.removeRecent');
    del.innerHTML = TRASH_ICON;
    del.onclick = (e) => {
      e.stopPropagation();
      if (!del.classList.contains('armed')) {
        del.classList.add('armed');
        del.title = t('armHint.removeRecent');
        showArmHint(del);
        return;
      }
      hideArmHint();
      row.remove();
      window.api.removeRecentFolder(dir).catch((err) => console.error('remove-recent-folder failed:', err));
    };

    row.append(item, del);
    recentMenu.appendChild(row);
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

// Ctrl/⌘+Shift+O opens the folder picker from anywhere.
// Capture phase so a focused xterm terminal can't swallow it first, mirroring
// quick-open's Ctrl+P.
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
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
initRemotePane();
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
// No project opens by default. With no folder open, skip the repo-driven loads
// and pop the recent-projects menu (the Open-folder button shows as pressed) so
// picking or browsing for a project is the launch screen's first action. Only a
// `--folder` CLI launch starts with a folder already open, in which case load
// everything as usual — including a one-time autoFetch so the ahead/behind
// badges reflect the remote without the user reaching for Sync.
window.api.getRepoPath().then((repo) => {
  if (repo) { refreshGit(); refreshTree(); loadToolbar(); autoFetch(); }
  else openRecentMenu();
}).catch((err) => console.error('startup repo check failed:', err));
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
