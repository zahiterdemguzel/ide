import { AUDIO_EXT, MODEL_EXT } from '../../shared/ext.js';
import { renderAudio } from './audio.js';
import { renderZoom } from './zoom.js';
import { renderPixelEditor } from './pixel-editor.js';
import { renderImageAdjust, canAdjust } from './image-adjust.js';
import { assetBtn } from './ui.js';

// --- asset view: image zoom / pixel editor / audio waveform / 3D model ---
// Dispatches by file type. Peer overlays / session terminals are hidden by the
// center coordinator before showAsset runs.
const assetView = document.getElementById('asset-view');
const assetBody = document.getElementById('asset-body');
const assetTools = document.getElementById('asset-tools');
const assetFile = document.getElementById('asset-file');

// A sub-view (the pixel editor, the 3D viewer) can install a document-level
// listener or an animation loop; it registers a teardown here so showing another
// asset / hiding the view removes it.
let activeCleanup = null;
function runCleanup() { if (activeCleanup) { activeCleanup(); activeCleanup = null; } }
const registerCleanup = (fn) => { activeCleanup = fn; };

// Clearing the body removes any <audio>, stopping playback and freeing memory.
export function hideAsset() { runCleanup(); assetView.style.display = 'none'; assetBody.innerHTML = ''; assetTools.innerHTML = ''; }

export async function showAsset(file, ext) {
  runCleanup();
  assetFile.textContent = file;
  assetTools.innerHTML = '';
  assetBody.innerHTML = '';
  assetView.style.display = 'flex';

  // "Open externally" is useful for every asset type — hand the file to the OS's
  // default program (a .glb in the system 3D viewer, an image in the photo app).
  const openExt = assetBtn('Open externally', async () => {
    const r = await window.api.openAssetExternal(file);
    if (r && r.ok === false && r.error) { openExt.textContent = 'Open failed'; }
  });
  openExt.title = "Open in the OS's default program for this file type";
  assetTools.appendChild(openExt);

  const r = await window.api.readAsset(file);
  if (!r.ok) { assetBody.textContent = r.error || 'Could not read file'; return; }

  if (MODEL_EXT.has(ext)) {
    // Loaded on demand so three.js (a large dependency) never costs app startup.
    // Guarded so a load/parse failure shows a message instead of a blank pane.
    try {
      const { renderModel } = await import('./model.js');
      renderModel(r.base64, ext, assetBody, assetTools, registerCleanup);
    } catch (e) {
      assetBody.textContent = 'Could not open 3D model: ' + (e && e.message ? e.message : e);
    }
    return;
  }

  const dataUrl = `data:${r.mime};base64,${r.base64}`;

  if (AUDIO_EXT.has(ext)) { renderAudio(dataUrl, r.base64, assetBody, registerCleanup); return; }

  const img = new Image();
  // PNGs small enough to paint pixel-by-pixel get the editor; the rest, zoom.
  img.onload = () => {
    if (ext === 'png' && img.naturalWidth < 200 && img.naturalHeight < 200) renderPixelEditor(file, img, assetBody, assetTools, registerCleanup);
    else renderImage(file, img, ext, assetBody, assetTools, registerCleanup);
  };
  img.onerror = () => { assetBody.textContent = 'Could not decode image'; };
  img.src = dataUrl;
}

// The plain image preview, with a switch between the zoom view and the adjustment
// view over the same decoded <img>. Each sub-view owns the body and its own slot
// of header buttons (`.asset-view-tools`), kept separate from the shared
// "Open externally" button so toggling doesn't wipe it. `registerCleanup` tears
// down whichever sub-view is active when the asset view closes.
function renderImage(file, img, ext, body, tools, registerCleanup) {
  const viewTools = document.createElement('span');
  viewTools.className = 'asset-view-tools';
  tools.insertBefore(viewTools, tools.firstChild);

  let subCleanup = null;
  const registerSub = (fn) => { subCleanup = fn; };
  const clear = () => {
    if (subCleanup) { subCleanup(); subCleanup = null; }
    viewTools.innerHTML = '';
    body.innerHTML = '';
  };
  const showZoom = () => { clear(); renderZoom(img, body, viewTools, registerSub, canAdjust(ext) ? showAdjust : null); };
  const showAdjust = () => { clear(); renderImageAdjust(file, img, ext, body, viewTools, registerSub, showZoom); };

  registerCleanup(() => { if (subCleanup) subCleanup(); });
  showZoom();
}
