import { assetBtn } from './ui.js';
import { PALETTE, hexToRgb, rgbToHex, shade } from './color.js';
import { floodFill } from '../../shared/pixel-ops.js';
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

  // A pixel-boundary grid overlaid on the canvas; only shown once pixels are big
  // enough that the lines mark cells instead of smothering them.
  const GRID_MIN_SCALE = 8;
  const grid = document.createElement('div');
  grid.className = 'pixel-grid';

  const applyScale = () => {
    canvas.style.width = (w * scale) + 'px'; canvas.style.height = (h * scale) + 'px';
    grid.style.width = (w * scale) + 'px'; grid.style.height = (h * scale) + 'px';
    grid.style.backgroundSize = scale + 'px ' + scale + 'px';
    grid.classList.toggle('on', scale >= GRID_MIN_SCALE);
    zoomLabel.textContent = scale + '×';
  };

  let color = PALETTE[0];
  // Tool state. The brush-size and fill-threshold sliders are the same widget
  // re-labelled per tool, but each keeps its own value (switching tools never
  // bleeds one into the other).
  let tool = 'pen'; // 'pen' | 'eraser' | 'fill'
  let brushSize = 1;
  let fillThreshold = 0;

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

  // Pen left-paints / right-erases; the eraser is the same brush with those
  // swapped. Returns 'paint' or 'erase' for the brush tools given the button
  // that started the stroke (0 = left, 2 = right).
  const brushAction = (button) => {
    const erase = button === 2;
    return (tool === 'eraser' ? !erase : erase) ? 'erase' : 'paint';
  };

  // Stamp a brushSize×brushSize block centred on (px, py). fillRect/clearRect
  // clip to the canvas, so blocks running off an edge need no bounds maths.
  const stamp = (px, py, action) => {
    const off = Math.floor((brushSize - 1) / 2);
    const x = px - off, y = py - off;
    if (action === 'erase') ctx.clearRect(x, y, brushSize, brushSize);
    else { ctx.fillStyle = color; ctx.fillRect(x, y, brushSize, brushSize); }
  };

  const flood = (px, py, action) => {
    const fill = action === 'erase' ? [0, 0, 0, 0] : [...hexToRgb(color), 255];
    const frame = ctx.getImageData(0, 0, w, h);
    floodFill(frame.data, w, h, px, py, fill, fillThreshold);
    ctx.putImageData(frame, 0, 0);
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

  let down = false, strokeAction = 'paint';
  let panning = false, panX = 0, panY = 0, scrollX = 0, scrollY = 0, panMoved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) { // middle: drag to pan, click (no drag) to eyedrop
      e.preventDefault();
      panning = true; panMoved = false;
      panX = e.clientX; panY = e.clientY; scrollX = viewport.scrollLeft; scrollY = viewport.scrollTop;
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    const [px, py] = coords(e);
    if (!inBounds(px, py)) return;
    if (tool === 'fill') {
      pushUndo();
      flood(px, py, e.button === 2 ? 'erase' : 'paint');
    } else {
      down = true;
      strokeAction = brushAction(e.button);
      pushUndo();
      stamp(px, py, strokeAction);
    }
  };
  canvas.onpointermove = (e) => {
    if (panning) {
      const dx = e.clientX - panX, dy = e.clientY - panY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
      viewport.scrollLeft = scrollX - dx; viewport.scrollTop = scrollY - dy;
    } else if (down) {
      const [px, py] = coords(e);
      if (inBounds(px, py)) stamp(px, py, strokeAction);
    }
  };
  canvas.onpointerup = (e) => {
    if (panning && !panMoved) pickAt(e); // middle click without dragging = eyedropper
    down = false; panning = false;
  };
  canvas.onpointercancel = () => { down = false; panning = false; };
  canvas.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); }; // block middle-click autoscroll
  canvas.onauxclick = (e) => { if (e.button === 1) e.preventDefault(); };
  canvas.oncontextmenu = (e) => e.preventDefault(); // right button is the erase/flood-erase stroke, not a menu

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

  // Tool rail (left side of the panel): pen, eraser, fill.
  const penBtn = toolBtn(ICON.pen, 'Pen — left paints, right erases', () => selectTool('pen'));
  const eraserBtn = toolBtn(ICON.eraser, 'Eraser — left erases, right paints', () => selectTool('eraser'));
  const fillBtn = toolBtn(ICON.fill, 'Fill — left fills, right flood-erases', () => selectTool('fill'));
  const toolButtons = { pen: penBtn, eraser: eraserBtn, fill: fillBtn };

  // One slider re-purposed per tool: brush size for pen/eraser, match threshold
  // for fill. Each tool's value is remembered separately in brushSize/fillThreshold.
  const sliderLabel = document.createElement('span');
  sliderLabel.className = 'pixel-slider-label';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'pixel-slider';
  const sliderValue = document.createElement('span');
  sliderValue.className = 'asset-pct';

  const syncSlider = () => {
    if (tool === 'fill') {
      sliderLabel.textContent = 'Threshold';
      slider.min = 0; slider.max = 100; slider.step = 1; slider.value = fillThreshold;
      sliderValue.textContent = fillThreshold + '%';
      slider.title = 'Fill threshold';
    } else {
      sliderLabel.textContent = 'Size';
      slider.min = 1; slider.max = 32; slider.step = 1; slider.value = brushSize;
      sliderValue.textContent = brushSize + ' px';
      slider.title = 'Brush size';
    }
  };
  slider.oninput = () => {
    const v = Number(slider.value);
    if (tool === 'fill') { fillThreshold = v; sliderValue.textContent = v + '%'; }
    else { brushSize = v; sliderValue.textContent = v + ' px'; }
  };

  const selectTool = (t) => {
    tool = t;
    for (const name in toolButtons) toolButtons[name].classList.toggle('on', name === t);
    syncSlider();
  };

  const swatches = document.createElement('div');
  swatches.className = 'palette';
  const selectColor = (c) => {
    color = c;
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
    group(sliderLabel, slider, sliderValue),
    group(swatches, picker, darkBtn, lightBtn),
    group(zoomOut, zoomLabel, zoomIn),
    group(undoBtn, redoBtn),
    spacer(),
    group(saveBtn, saved),
  );

  // Floating tool rail pinned to the viewport's left-center edge (Blender-style),
  // so the tools sit next to the art instead of crowding the bottom panel.
  const toolbar = document.createElement('div');
  toolbar.className = 'pixel-toolbar';
  toolbar.append(penBtn, eraserBtn, fillBtn);

  const stage = document.createElement('div');
  stage.className = 'pixel-stage';
  stage.append(canvas, grid);
  viewport.appendChild(stage);

  // `main` is the non-scrolling positioning context for the rail; the viewport
  // scrolls inside it while the rail stays put.
  const main = document.createElement('div');
  main.className = 'pixel-main';
  main.append(viewport, toolbar);

  const editor = document.createElement('div');
  editor.className = 'pixel-editor';
  editor.append(main, panel);
  body.appendChild(editor);

  applyScale();
  selectColor(color);
  selectTool('pen');
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

// An icon-only tool button (pen/eraser/fill). `svg` is inline markup; the icon
// inherits the button's currentColor so it flips to --on-accent when active.
function toolBtn(svg, title, onclick) {
  const b = document.createElement('button');
  b.className = 'pixel-tool';
  b.title = title;
  b.innerHTML = svg;
  b.onclick = onclick;
  return b;
}

const ICON = {
  pen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.2l2.5 2.5L6 12.5l-3.2 1 1-3.2z"/><path d="M10.2 3.3l2.5 2.5"/></svg>',
  eraser: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8.4 3.1l4.5 4.5-5 5H4.3L1.6 9.9z"/><path d="M2.5 13.5h11"/></svg>',
  fill: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.3 1.6l5.6 5.6-5 5L1.3 6.6z"/><path d="M5 2.9L4 1.9"/><path d="M13.5 9.6s1.4 1.7 1.4 2.8a1.4 1.4 0 0 1-2.8 0c0-1.1 1.4-2.8 1.4-2.8z"/></svg>',
};
