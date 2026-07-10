console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval viewer/center.js'); // PERF-TEMP
import { IMG_EXT, AUDIO_EXT, MODEL_EXT, VECTOR_EXT, PDF_EXT, SHEET_EXT, DB_EXT, extOf } from '../shared/ext.js';
import { hideDiff } from './code-render.js';
import { showDiff, showCommit, showStash } from './diff.js';
import { showFile } from './file.js';
import { showArmHint, hideArmHint } from '../shared/arm-hint.js';

// --- center coordinator ---
// Single owner of the center pane's overlays (diff / file / asset / web). Every
// "show X" first clears the pane, so individual view modules don't need to know
// about each other. Sessions and the explorer/git/terminal-link callers route
// through here, which keeps the dependency graph one-directional: this module
// imports the views but never imports sessions (the close-to-session hand-off is
// a callback registered via onClose()).

// Lazy viewer modules. The asset (image/pixel/audio/3D/vector), spreadsheet,
// database, and browser views each carry their own DOM wiring and pull in large
// libraries (three.js / paper.js / SheetJS). None is needed until the user opens
// a file of that type or the browser, so each is imported on first use rather
// than at startup — the diff and text editor stay eager since they're on the
// common path. `mod.<key>` caches the resolved module so the synchronous hide*
// paths can no-op when a viewer was never opened (its overlay is already hidden,
// so there's nothing to tear down).
const mod = { asset: null, sheet: null, db: null, web: null };
const importers = {
  asset: () => import('./asset/index.js'),
  sheet: () => import('./sheet/index.js'),
  db: () => import('./db/index.js'),
  web: () => import('./web.js'),
};
const pending = {};
async function load(key) {
  if (!mod[key]) mod[key] = await (pending[key] ||= importers[key]());
  return mod[key];
}

const emptyHint = document.getElementById('empty-hint');
const sessionBar = document.getElementById('session-bar');

export function hideAllOverlays() {
  hideDiff();
  if (mod.asset) mod.asset.hideAsset();
  if (mod.sheet) mod.sheet.hideSheet();
  if (mod.db) mod.db.hideDb();
  if (mod.web) mod.web.hideWeb();
}

// Hide the per-session terminal containers via the DOM (no import of sessions).
// The session bar (commit/revert) belongs to the terminal view, so hide it too —
// it's restored by sessions' updateSessionBar() when a session is shown again.
function hideSessionViews() {
  for (const el of document.querySelectorAll('#terminal-host .term-container')) el.style.display = 'none';
  emptyHint.style.display = 'none';
  sessionBar.style.display = 'none';
}

function clearCenter() { hideAllOverlays(); hideSessionViews(); }

// Route a file opened from the tree/search: images/audio/3D-models/vector → asset
// viewer, everything else → read-only text view. `jump` (optional { line, term }).
export async function openFromTree(file, jump) {
  clearCenter();
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext) || MODEL_EXT.has(ext) || VECTOR_EXT.has(ext) || PDF_EXT.has(ext)) (await load('asset')).showAsset(file, ext);
  else if (SHEET_EXT.has(ext)) (await load('sheet')).showSheet(file, ext);
  else if (DB_EXT.has(ext)) (await load('db')).showDb(file, ext);
  else showFile(file, jump);
}

// Route a clicked git row: images/audio/3D-models/vector → asset viewer,
// database files → the database viewer, else → diff.
export async function openGitFile(file, status, staged) {
  clearCenter();
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext) || MODEL_EXT.has(ext) || VECTOR_EXT.has(ext) || PDF_EXT.has(ext)) (await load('asset')).showAsset(file, ext);
  else if (DB_EXT.has(ext)) (await load('db')).showDb(file, ext);
  else showDiff(file, status, staged);
}

// Open a historical commit's patch (History tab) in the diff overlay.
export function openCommit(hash, subject) { clearCenter(); showCommit(hash, subject); }

// Open a stash's patch (Stashes section) in the diff overlay.
export function openStash(ref, message) { clearCenter(); showStash(ref, message); }

export async function showWeb(url) { clearCenter(); (await load('web')).showWeb(url); }

// Toolbar browser button: toggle the (persistent) browser overlay. If it's
// already showing, close it (back to the active session); the page keeps running
// in the background — closing is not terminating. Otherwise reveal it.
export async function toggleWeb() {
  if (mod.web && mod.web.isWebOpen()) { closeOverlay(); return; }
  clearCenter();
  (await load('web')).openWeb();
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
document.getElementById('sheet-close').onclick = closeOverlay;
document.getElementById('db-close').onclick = closeOverlay;
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
  // The terminate button is only reachable while the browser overlay is open, so
  // the web module is already loaded; guard anyway to stay side-effect-free.
  if (mod.web) mod.web.terminateWeb();
  closeOverlay();
};
