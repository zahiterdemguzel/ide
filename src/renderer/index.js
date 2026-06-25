// Renderer entry point. Importing each feature module runs its wiring as a side
// effect (DOM event handlers, IPC listeners); this file then registers the
// cross-module hand-offs and kicks off the initial loads.
import './shared/bootstrap.js';
import { onClose } from './viewer/center.js';
import { showActiveSession } from './sessions.js';
import { refreshGit } from './git-pane.js';
import { refreshTree } from './explorer/tree.js';
import './explorer/search.js';
import './terminal-links.js';
import { loadToolbar } from './toolbar.js';
import { initConsoles } from './consoles.js';
import './panes.js';

// Closing a center overlay returns to the active session (sessions owns it).
onClose(showActiveSession);

// Open folder: re-point the repo, then reload everything that depends on it.
document.getElementById('open-folder').onclick = async () => {
  try {
    const current = await window.api.getRepoPath();
    if (current) {
      const ok = window.confirm(`Change folder?\n\nCurrent: ${current}\n\nThis will reload the file tree, git pane, and toolbar.`);
      if (!ok) return;
    }
    const r = await window.api.openFolder();
    if (r.error) console.error('open-folder:', r.error);
    if (!r.canceled) { window.api.setWindowTitle(r.repo); refreshGit(); refreshTree(); loadToolbar(); }
  } catch (err) {
    console.error('open-folder click failed:', err);
  }
};

initConsoles();
refreshGit();
refreshTree();
loadToolbar();
// ponytail: poll while focused; a file watcher would be more code for no real gain
setInterval(() => { if (document.hasFocus()) refreshGit(); }, 3000);
