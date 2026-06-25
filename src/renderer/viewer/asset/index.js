import { AUDIO_EXT } from '../../shared/ext.js';
import { renderAudio } from './audio.js';
import { renderZoom } from './zoom.js';
import { renderPixelEditor } from './pixel-editor.js';

// --- asset view: image zoom / pixel editor / audio waveform ---
// Dispatches by file type. Peer overlays / session terminals are hidden by the
// center coordinator before showAsset runs.
const assetView = document.getElementById('asset-view');
const assetBody = document.getElementById('asset-body');
const assetTools = document.getElementById('asset-tools');
const assetFile = document.getElementById('asset-file');

// A sub-view (the pixel editor) can install a document-level listener; it
// registers a teardown here so showing another asset / hiding the view removes it.
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

  const r = await window.api.readAsset(file);
  if (!r.ok) { assetBody.textContent = r.error || 'Could not read file'; return; }
  const dataUrl = `data:${r.mime};base64,${r.base64}`;

  if (AUDIO_EXT.has(ext)) { renderAudio(dataUrl, r.base64, assetBody, registerCleanup); return; }

  const img = new Image();
  // PNGs small enough to paint pixel-by-pixel get the editor; the rest, zoom.
  img.onload = () => {
    if (ext === 'png' && img.naturalWidth < 200 && img.naturalHeight < 200) renderPixelEditor(file, img, assetBody, assetTools, registerCleanup);
    else renderZoom(img, assetBody, assetTools);
  };
  img.onerror = () => { assetBody.textContent = 'Could not decode image'; };
  img.src = dataUrl;
}
