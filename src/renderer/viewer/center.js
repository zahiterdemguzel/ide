import { IMG_EXT, AUDIO_EXT, extOf } from '../shared/ext.js';
import { hideDiff } from './code-render.js';
import { showDiff, showCommit, showStash } from './diff.js';
import { showFile } from './file.js';
import { showAsset, hideAsset } from './asset/index.js';
import { showWeb as showWebView, openWeb as openWebView, hideWeb, terminateWeb, isWebOpen } from './web.js';
import { showArmHint, hideArmHint } from '../shared/arm-hint.js';

// --- center coordinator ---
// Single owner of the center pane's overlays (diff / file / asset / web). Every
// "show X" first clears the pane, so individual view modules don't need to know
// about each other. Sessions and the explorer/git/terminal-link callers route
// through here, which keeps the dependency graph one-directional: this module
// imports the views but never imports sessions (the close-to-session hand-off is
// a callback registered via onClose()).

const emptyHint = document.getElementById('empty-hint');
const sessionBar = document.getElementById('session-bar');

export function hideAllOverlays() { hideDiff(); hideAsset(); hideWeb(); }

// Hide the per-session terminal containers via the DOM (no import of sessions).
// The session bar (commit/revert) belongs to the terminal view, so hide it too —
// it's restored by sessions' updateSessionBar() when a session is shown again.
function hideSessionViews() {
  for (const el of document.querySelectorAll('#terminal-host .term-container')) el.style.display = 'none';
  emptyHint.style.display = 'none';
  sessionBar.style.display = 'none';
}

function clearCenter() { hideAllOverlays(); hideSessionViews(); }

// Route a file opened from the tree/search: images/audio → asset viewer,
// everything else → read-only text view. `jump` (optional { line, term }).
export function openFromTree(file, jump) {
  clearCenter();
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showFile(file, jump);
}

// Route a clicked git row: images/audio → asset viewer, everything else → diff.
export function openGitFile(file, status, staged) {
  clearCenter();
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showDiff(file, status, staged);
}

// Open a historical commit's patch (History tab) in the diff overlay.
export function openCommit(hash, subject) { clearCenter(); showCommit(hash, subject); }

// Open a stash's patch (Stashes section) in the diff overlay.
export function openStash(ref, message) { clearCenter(); showStash(ref, message); }

export function showWeb(url) { clearCenter(); showWebView(url); }

// Toolbar browser button: toggle the (persistent) browser overlay. If it's
// already showing, close it (back to the active session); the page keeps running
// in the background — closing is not terminating. Otherwise reveal it.
export function toggleWeb() {
  if (isWebOpen()) { closeOverlay(); return; }
  clearCenter();
  openWebView();
}

// Closing any overlay returns to the active session, or the empty hint if none.
// sessions registers showActiveSession() here so this module needn't import it.
let onCloseCb = null;
export function onClose(fn) { onCloseCb = fn; }
export function closeOverlay() {
  if (onCloseCb && onCloseCb()) return; // returned true → an active session was shown
  hideAllOverlays();
  hideSessionViews();
  emptyHint.style.display = 'flex';
}

document.getElementById('diff-close').onclick = closeOverlay;
document.getElementById('asset-close').onclick = closeOverlay;
document.getElementById('web-close').onclick = closeOverlay;
document.getElementById('browser-btn').onclick = toggleWeb;

// Terminate is destructive (it unloads the page), so it arms on the first click
// and only kills the browser on the second — the same two-click pattern as the
// git pane's discard/revert buttons. closeOverlay() then returns to the session.
const webTerminate = document.getElementById('web-terminate');
webTerminate.onclick = () => {
  if (!webTerminate.classList.contains('armed')) {
    webTerminate.classList.add('armed');
    showArmHint(webTerminate);
    return;
  }
  hideArmHint();
  webTerminate.classList.remove('armed');
  terminateWeb();
  closeOverlay();
};
