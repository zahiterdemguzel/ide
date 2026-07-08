import { AUDIO_EXT, MODEL_EXT, EDITABLE_MODEL_EXT, VECTOR_EXT, EDITABLE_VECTOR_EXT, PDF_EXT } from '../../shared/ext.js';
import { renderAudio } from './audio.js';
import { renderZoom } from './zoom.js';
import { renderPixelEditor } from './pixel-editor.js';
import { renderImageAdjust, canAdjust } from './image-adjust.js';
import { renderIcoView } from './ico-view.js';
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
    renderModelCoordinator(file, r.base64, ext, assetBody, assetTools, registerCleanup);
    return;
  }

  if (VECTOR_EXT.has(ext)) {
    renderVectorCoordinator(file, r.base64, ext, assetBody, assetTools, registerCleanup);
    return;
  }

  if (PDF_EXT.has(ext)) {
    renderPdfCoordinator(file, r.base64, ext, assetBody, assetTools, registerCleanup);
    return;
  }

  // .ico is a multi-image container: show every embedded size, not the one
  // frame Chromium would pick for a plain <img>.
  if (ext === 'ico') {
    renderIcoView(file, r.base64, assetBody, assetTools, registerCleanup);
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

// 3D model coordinator: switches between the read-only viewer and the editor over
// the same loaded bytes, mirroring renderImage's zoom↔adjust switch. The Edit
// button (read-only viewer) calls showEdit; entering edit mode tags #asset-tools
// with `asset-edit-mode` so the CSS hides "Open externally", leaving only the
// editor's Save button in the header. Each sub-view owns its own header-button
// slot (`viewTools`) and cleanup (`registerSub`); switching re-parses from the
// same base64 so each mode gets a clean scene. Editing is offered for glTF/GLB
// only (EDITABLE_MODEL_EXT) — the formats GLTFExporter can write back.
function renderModelCoordinator(file, base64, ext, body, tools, registerCleanup) {
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

  const editable = EDITABLE_MODEL_EXT.has(ext);
  // Loaded on demand so three.js (a large dependency) never costs app startup;
  // guarded so a load/parse failure shows a message instead of a blank pane.
  const showView = async () => {
    clear();
    tools.classList.remove('asset-edit-mode');
    try {
      const { renderModel } = await import('./model.js');
      renderModel(base64, ext, body, viewTools, registerSub, editable ? showEdit : null);
    } catch (e) {
      body.textContent = 'Could not open 3D model: ' + (e && e.message ? e.message : e);
    }
  };
  const showEdit = async () => {
    clear();
    tools.classList.add('asset-edit-mode');
    try {
      const { renderModelEditor } = await import('./model-editor.js');
      renderModelEditor(file, base64, ext, body, viewTools, registerSub);
    } catch (e) {
      body.textContent = 'Could not open 3D editor: ' + (e && e.message ? e.message : e);
    }
  };

  registerCleanup(() => { if (subCleanup) subCleanup(); tools.classList.remove('asset-edit-mode'); });
  showView();
}

// PDF coordinator: mirrors renderModelCoordinator for .pdf. The view is a
// pdf.js page renderer (read-only, pan/zoom); Edit hands off to the page-level
// editor (rotate / delete / reorder pages via pdf-lib). Both modules import
// their library lazily, so a PDF costs nothing until one is opened.
function renderPdfCoordinator(file, base64, ext, body, tools, registerCleanup) {
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

  const showView = async () => {
    clear();
    tools.classList.remove('asset-edit-mode');
    try {
      const { renderPdfView } = await import('./pdf-view.js');
      await renderPdfView(base64, body, viewTools, registerSub, showEdit);
    } catch (e) {
      body.textContent = 'Could not open PDF: ' + (e && e.message ? e.message : e);
    }
  };
  const showEdit = async () => {
    clear();
    tools.classList.add('asset-edit-mode');
    try {
      const { renderPdfEditor } = await import('./pdf-editor.js');
      await renderPdfEditor(file, base64, body, viewTools, registerSub, (newBase64) => {
        base64 = newBase64; // the saved bytes become the view's baseline
        showView();
      });
    } catch (e) {
      body.textContent = 'Could not open PDF editor: ' + (e && e.message ? e.message : e);
    }
  };

  registerCleanup(() => { if (subCleanup) subCleanup(); tools.classList.remove('asset-edit-mode'); });
  showView();
}

// Vector coordinator: mirrors renderModelCoordinator for .svg/.ai. The view is a
// pan/zoom preview (read-only); for SVG (EDITABLE_VECTOR_EXT) an Edit button hands
// off to the full paper.js editor. .ai is view-only (a PDF/PostScript wrapper with
// no pure-JS write-back), so it shows an info card and no Edit button. paper.js is
// loaded lazily by the editor module, so it costs nothing until Edit is pressed.
function renderVectorCoordinator(file, base64, ext, body, tools, registerCleanup) {
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

  const editable = EDITABLE_VECTOR_EXT.has(ext);
  const showView = async () => {
    clear();
    tools.classList.remove('asset-edit-mode');
    try {
      const { renderVectorView } = await import('./vector-view.js');
      renderVectorView(file, base64, ext, body, viewTools, registerSub, editable ? showEdit : null);
    } catch (e) {
      body.textContent = 'Could not open vector file: ' + (e && e.message ? e.message : e);
    }
  };
  const showEdit = async () => {
    clear();
    tools.classList.add('asset-edit-mode');
    try {
      const { renderVectorEditor } = await import('./vector-editor.js');
      renderVectorEditor(file, base64, ext, body, viewTools, registerSub);
    } catch (e) {
      body.textContent = 'Could not open vector editor: ' + (e && e.message ? e.message : e);
    }
  };

  registerCleanup(() => { if (subCleanup) subCleanup(); tools.classList.remove('asset-edit-mode'); });
  showView();
}
