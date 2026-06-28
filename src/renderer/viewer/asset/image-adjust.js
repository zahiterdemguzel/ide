import { assetBtn } from './ui.js';
import { ADJUSTMENTS, DEFAULTS, isNeutral, applyAdjustments } from '../../shared/adjust-ops.js';
import { refreshGit } from '../../git-pane.js';

// Raster formats a canvas can re-encode, so the adjusted pixels can overwrite the
// file in its original format. SVG (vector) and animated GIF can't round-trip
// through a canvas without loss, so the Adjust button is hidden for them.
const ENCODE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const canAdjust = (ext) => Boolean(ENCODE[ext]);

// Image adjustment view: a fitted preview canvas above a panel of sliders
// (brightness/contrast/saturation/exposure/vibrance/temperature/tint). Every
// change re-renders the preview live; Apply bakes it back into the file. Mirrors
// the pixel editor's layout (scroll viewport + bottom control panel) so the two
// image views read consistently. `onDone` returns to the plain zoom view.
export function renderImageAdjust(file, img, ext, body, tools, registerCleanup, onDone) {
  const w = img.naturalWidth, h = img.naturalHeight;

  // Source pixels, read once; the preview is recomputed from these on every edit
  // (so adjustments never compound — they always apply to the original).
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = w; srcCanvas.height = h;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const srcData = sctx.getImageData(0, 0, w, h);
  const out = new ImageData(w, h); // reused output buffer

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.className = 'adjust-canvas';
  const ctx = canvas.getContext('2d');

  const values = { ...DEFAULTS };

  // rAF-coalesced render: dragging a slider fires many `input` events per frame,
  // but the (potentially multi-megapixel) pipeline runs at most once per frame.
  let rafId = 0, queued = false;
  const render = () => {
    queued = false;
    applyAdjustments(srcData.data, out.data, values);
    ctx.putImageData(out, 0, 0);
  };
  const schedule = () => { if (!queued) { queued = true; rafId = requestAnimationFrame(render); } };
  render();

  // --- slider grid ---
  const grid = document.createElement('div');
  grid.className = 'adjust-grid';
  const rows = [];
  for (const a of ADJUSTMENTS) {
    const row = document.createElement('label');
    row.className = 'adjust-row';
    const name = document.createElement('span');
    name.className = 'adjust-name';
    name.textContent = a.label;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '-100'; slider.max = '100'; slider.value = '0';
    slider.className = 'adjust-slider';
    const val = document.createElement('span');
    val.className = 'adjust-val';
    val.textContent = '0';
    const onInput = () => {
      const n = Number(slider.value);
      values[a.key] = n;
      val.textContent = (n > 0 ? '+' : '') + n;
      val.classList.toggle('changed', n !== 0);
      schedule();
      refreshState();
    };
    slider.oninput = onInput;
    slider.ondblclick = () => { slider.value = '0'; onInput(); }; // double-click zeroes one control
    row.append(name, slider, val);
    grid.appendChild(row);
    rows.push({ slider, onInput });
  }

  // --- footer: reset · status · apply ---
  const status = document.createElement('span');
  status.className = 'asset-pct adjust-status';

  const resetBtn = assetBtn('Reset all', () => { for (const r of rows) { r.slider.value = '0'; r.onInput(); } });

  let saving = false;
  const applyBtn = assetBtn('Apply', async () => {
    if (saving || isNeutral(values)) return;
    saving = true; applyBtn.textContent = 'Saving…'; status.textContent = ''; refreshState();
    render(); // ensure the canvas holds the latest values before we encode it
    const base64 = canvas.toDataURL(ENCODE[ext], 0.95).split(',')[1];
    const r = await window.api.writeAsset(file, base64);
    saving = false; applyBtn.textContent = 'Apply';
    if (r.ok) {
      // The applied pixels become the new baseline, so further tweaks start from
      // them and the sliders return to neutral.
      srcData.data.set(out.data);
      for (const x of rows) { x.slider.value = '0'; x.onInput(); }
      status.textContent = 'Saved';
      refreshGit();
    } else {
      status.textContent = r.error || 'Save failed';
      refreshState();
    }
  });
  applyBtn.classList.add('adjust-apply');

  function refreshState() {
    const neutral = isNeutral(values);
    resetBtn.disabled = neutral;
    applyBtn.disabled = neutral || saving;
    if (!neutral) status.textContent = '';
  }

  const footer = document.createElement('div');
  footer.className = 'adjust-footer';
  footer.append(resetBtn, status, applyBtn);

  const panel = document.createElement('div');
  panel.className = 'adjust-panel';
  panel.append(grid, footer);

  const viewport = document.createElement('div');
  viewport.className = 'adjust-viewport';
  viewport.appendChild(canvas);

  const editor = document.createElement('div');
  editor.className = 'adjust-editor';
  editor.append(viewport, panel);
  body.appendChild(editor);

  const doneBtn = assetBtn('Done', onDone);
  doneBtn.title = 'Back to image view';
  tools.append(doneBtn);

  refreshState();
  registerCleanup(() => cancelAnimationFrame(rafId));
}
