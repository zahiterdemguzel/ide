import { assetBtn } from './ui.js';
import { PALETTE, rgbToHex, shade } from './color.js';
import { refreshGit } from '../../git-pane.js';

// Pixel editor for small PNGs. `body`/`tools` are the asset view's containers;
// `registerCleanup(fn)` lets the editor tear its keydown listener down when the
// view is hidden or another asset is opened (the asset coordinator runs it).
export function renderPixelEditor(file, img, body, tools, registerCleanup) {
  const w = img.naturalWidth, h = img.naturalHeight;
  let scale = Math.max(1, Math.floor(384 / Math.max(w, h))); // blow tiny art up to ~screen size
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.className = 'pixel-canvas';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const applyScale = () => { canvas.style.width = (w * scale) + 'px'; canvas.style.height = (h * scale) + 'px'; };
  applyScale();

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

  let down = false, panning = false, panX = 0, panY = 0, scrollX = 0, scrollY = 0, panMoved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) { // middle: drag to pan, click (no drag) to eyedrop
      e.preventDefault();
      panning = true; panMoved = false;
      panX = e.clientX; panY = e.clientY; scrollX = body.scrollLeft; scrollY = body.scrollTop;
    } else { down = true; pushUndo(); paintAt(e); }
  };
  canvas.onpointermove = (e) => {
    if (panning) {
      const dx = e.clientX - panX, dy = e.clientY - panY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
      body.scrollLeft = scrollX - dx; body.scrollTop = scrollY - dy;
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

  const saved = document.createElement('span');
  saved.className = 'asset-pct';
  const saveBtn = assetBtn('Save', async () => {
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const r = await window.api.writeAsset(file, base64);
    saved.textContent = r.ok ? 'Saved' : (r.error || 'Save failed');
    if (r.ok) refreshGit();  });

  tools.append(swatches, picker, darkBtn, lightBtn, eraseBtn, assetBtn('↶', undo), assetBtn('↷', redo), saveBtn, saved);
  const stage = document.createElement('div');
  stage.className = 'pixel-stage';
  stage.appendChild(canvas);
  body.appendChild(stage);
  selectColor(color);
}
