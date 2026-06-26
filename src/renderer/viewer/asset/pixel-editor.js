import { assetBtn } from './ui.js';
import { PALETTE, rgbToHex, shade } from './color.js';
import { refreshGit } from '../../git-pane.js';

// Pixel editor for small PNGs. `body` is the asset view's scroll container;
// `tools` is the shared top toolbar — the editor leaves it empty and instead
// builds its own bottom panel so its many controls don't crowd the header's
// close button. `registerCleanup(fn)` tears the keydown listener down when the
// view is hidden or another asset is opened (the asset coordinator runs it).
export function renderPixelEditor(file, img, body, tools, registerCleanup) {
  const w = img.naturalWidth, h = img.naturalHeight;
  let scale = Math.max(1, Math.floor(384 / Math.max(w, h))); // blow tiny art up to ~screen size
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.className = 'pixel-canvas';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const applyScale = () => {
    canvas.style.width = (w * scale) + 'px'; canvas.style.height = (h * scale) + 'px';
    zoomLabel.textContent = scale + '×';
  };

  let color = PALETTE[0];
  let erasing = false;

  // ponytail: 50-state ImageData ring — full-frame snapshots, fine for sub-200px art; switch to per-stroke diffs if memory bites.
  const undoStack = [], redoStack = [];
  const pushUndo = () => { undoStack.push(ctx.getImageData(0, 0, w, h)); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0; };
  const undo = () => { if (undoStack.length) { redoStack.push(ctx.getImageData(0, 0, w, h)); ctx.putImageData(undoStack.pop(), 0, 0); } };
  const redo = () => { if (redoStack.length) { undoStack.push(ctx.getImageData(0, 0, w, h)); ctx.putImageData(redoStack.pop(), 0, 0); } };

  const coords = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [Math.floor((e.clientX - rect.left) / scale), Math.floor((e.clientY - rect.top) / scale)];
  };
  const inBounds = (px, py) => px >= 0 && py >= 0 && px < w && py < h;
  const paintAt = (e) => {
    const [px, py] = coords(e);
    if (!inBounds(px, py)) return;
    if (erasing) ctx.clearRect(px, py, 1, 1);
    else { ctx.fillStyle = color; ctx.fillRect(px, py, 1, 1); }
  };
  const pickAt = (e) => {
    const [px, py] = coords(e);
    if (!inBounds(px, py)) return;
    const d = ctx.getImageData(px, py, 1, 1).data;
    if (d[3]) selectColor(rgbToHex(d[0], d[1], d[2])); // skip transparent pixels — no color to pick
  };

  // The canvas scrolls inside a dedicated viewport (so the bottom panel stays put).
  const viewport = document.createElement('div');
  viewport.className = 'pixel-viewport';

  let down = false, panning = false, panX = 0, panY = 0, scrollX = 0, scrollY = 0, panMoved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) { // middle: drag to pan, click (no drag) to eyedrop
      e.preventDefault();
      panning = true; panMoved = false;
      panX = e.clientX; panY = e.clientY; scrollX = viewport.scrollLeft; scrollY = viewport.scrollTop;
    } else { down = true; pushUndo(); paintAt(e); }
  };
  canvas.onpointermove = (e) => {
    if (panning) {
      const dx = e.clientX - panX, dy = e.clientY - panY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
      viewport.scrollLeft = scrollX - dx; viewport.scrollTop = scrollY - dy;
    } else if (down) paintAt(e);
  };
  canvas.onpointerup = (e) => {
    if (panning && !panMoved) pickAt(e); // middle click without dragging = eyedropper
    down = false; panning = false;
  };
  canvas.onpointercancel = () => { down = false; panning = false; };
  canvas.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); }; // block middle-click autoscroll
  canvas.onauxclick = (e) => { if (e.button === 1) e.preventDefault(); };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(1, Math.min(48, e.deltaY < 0 ? scale + 1 : scale - 1));
    applyScale();
  }, { passive: false });

  const keyHandler = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  document.addEventListener('keydown', keyHandler);
  registerCleanup(() => document.removeEventListener('keydown', keyHandler));

  // --- controls (all live in the bottom panel, grouped into labeled sections) ---
  const swatches = document.createElement('div');
  swatches.className = 'palette';
  const eraseBtn = assetBtn('Erase', () => { erasing = !erasing; eraseBtn.classList.toggle('on', erasing); });
  const selectColor = (c) => {
    color = c; erasing = false; eraseBtn.classList.remove('on');
    picker.value = c;
    for (const sw of swatches.children) sw.classList.toggle('sel', sw.dataset.c === c);
  };
  for (const c of PALETTE) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.c = c;
    sw.style.background = c;
    sw.onclick = () => selectColor(c);
    swatches.appendChild(sw);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'asset-picker';
  picker.value = color;
  picker.oninput = () => selectColor(picker.value);

  const darkBtn = assetBtn('−', () => selectColor(shade(color, -0.12)));
  const lightBtn = assetBtn('+', () => selectColor(shade(color, 0.12)));
  darkBtn.title = 'Darken color';
  lightBtn.title = 'Lighten color';

  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'asset-pct';
  const zoomOut = assetBtn('−', () => { scale = Math.max(1, scale - 1); applyScale(); });
  const zoomIn = assetBtn('+', () => { scale = Math.min(48, scale + 1); applyScale(); });
  zoomOut.title = 'Zoom out';
  zoomIn.title = 'Zoom in';

  const undoBtn = assetBtn('↶', undo);
  const redoBtn = assetBtn('↷', redo);
  undoBtn.title = 'Undo (Ctrl+Z)';
  redoBtn.title = 'Redo (Ctrl+Y)';

  const saved = document.createElement('span');
  saved.className = 'asset-pct';
  const saveBtn = assetBtn('Save', async () => {
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const r = await window.api.writeAsset(file, base64);
    saved.textContent = r.ok ? 'Saved' : (r.error || 'Save failed');
    if (r.ok) refreshGit();
  });
  saveBtn.classList.add('pixel-save');

  const panel = document.createElement('div');
  panel.className = 'pixel-panel';
  panel.append(
    group(swatches, picker, darkBtn, lightBtn),
    group(eraseBtn),
    group(zoomOut, zoomLabel, zoomIn),
    group(undoBtn, redoBtn),
    spacer(),
    group(saveBtn, saved),
  );

  const stage = document.createElement('div');
  stage.className = 'pixel-stage';
  stage.appendChild(canvas);
  viewport.appendChild(stage);

  const editor = document.createElement('div');
  editor.className = 'pixel-editor';
  editor.append(viewport, panel);
  body.appendChild(editor);

  applyScale();
  selectColor(color);
}

// A panel section: a row of related controls bounded by the panel's separators.
function group(...children) {
  const g = document.createElement('div');
  g.className = 'pixel-group';
  g.append(...children);
  return g;
}

function spacer() {
  const s = document.createElement('div');
  s.className = 'pixel-spacer';
  return s;
}
