import { layoutScene, pickAt, pickInRect, snapTargets, snapRect } from '../../shared/control-layout.js';
import { createPainter } from './ui-draw.js';

// The 2D UI viewport: a Canvas2D painter over the layout engine, plus every
// direct-manipulation gesture (pan, zoom, marquee, move, 8-handle resize).
// The canvas owns no state about the scene — it re-lays out from the document
// on demand and calls back into the editor for every mutation, so undo/redo
// only has to restore document text.

const RULER = 18;         // px gutter for the rulers
const HANDLE = 8;         // px side of a resize handle
const SNAP_TOL = 6;       // px (screen) a drag snaps within
const MIN_ZOOM = 0.05, MAX_ZOOM = 16;

// The 8 resize handles, as unit positions within the selection rect.
const HANDLES = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' },
  { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' },
  { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' },
  { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' },
  { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' },
  { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
];

export function createUiCanvas(host, api) {
  const wrap = document.createElement('div');
  wrap.className = 'uis-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'uis-canvas';
  canvas.tabIndex = 0;
  wrap.appendChild(canvas);
  host.appendChild(wrap);
  const ctx = canvas.getContext('2d');

  // A detached context purely for text metrics, so measuring never disturbs the
  // painter's transform.
  const measureCtx = document.createElement('canvas').getContext('2d');
  const painter = createPainter({ doc: api.getDoc(), measureCtx, textureFor: api.textureFor });

  let zoom = 1, panX = RULER + 20, panY = RULER + 20;
  let layout = new Map();
  let guides = { xs: [], ys: [] };
  let marquee = null;
  let showGrid = true, gridStep = 8, snapToGrid = false;

  const toScene = (sx, sy) => ({ x: (sx - panX) / zoom, y: (sy - panY) / zoom });
  const toScreen = (x, y) => ({ x: x * zoom + panX, y: y * zoom + panY });
  const eventPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const relayout = () => {
    painter.setDoc(api.getDoc());
    layout = layoutScene(api.getDoc(), { viewportSize: api.getViewportSize(), measure: painter.measure });
    return layout;
  };

  // --- painting ---
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };

  const drawGrid = (w, h) => {
    const step = gridStep * zoom;
    if (!showGrid || step < 4) return;
    const start = { x: Math.floor(-panX / step) * step + panX, y: Math.floor(-panY / step) * step + panY };
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = start.x; x < w; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h); }
    for (let y = start.y; y < h; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5); }
    ctx.stroke();
  };

  const drawViewportFrame = () => {
    const v = api.getViewportSize();
    const a = toScreen(0, 0), b = toScreen(v.width, v.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = 'rgba(120, 160, 210, 0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, b.x - a.x, b.y - a.y);
  };

  // Ruler ticks at a round scene interval that stays ≥60px apart on screen.
  const drawRulers = (w, h) => {
    ctx.fillStyle = 'rgba(20, 22, 26, 0.95)';
    ctx.fillRect(0, 0, w, RULER);
    ctx.fillRect(0, 0, RULER, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, RULER + 0.5); ctx.lineTo(w, RULER + 0.5);
    ctx.moveTo(RULER + 0.5, 0); ctx.lineTo(RULER + 0.5, h);
    ctx.stroke();

    let step = 10;
    while (step * zoom < 60) step *= step % 25 === 0 ? 2 : (step === 10 ? 2.5 : 2);
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(200, 205, 215, 0.7)';
    ctx.textBaseline = 'top';
    const first = Math.ceil(-panX / zoom / step) * step;
    for (let s = first; ; s += step) {
      const p = toScreen(s, 0).x;
      if (p > w) break;
      if (p >= RULER) { ctx.fillRect(p, RULER - 4, 1, 4); ctx.fillText(String(Math.round(s)), p + 2, 3); }
    }
    const firstY = Math.ceil(-panY / zoom / step) * step;
    for (let s = firstY; ; s += step) {
      const p = toScreen(0, s).y;
      if (p > h) break;
      if (p >= RULER) {
        ctx.fillRect(RULER - 4, p, 4, 1);
        ctx.save();
        ctx.translate(3, p + 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textBaseline = 'bottom';
        ctx.fillText(String(Math.round(s)), -ctx.measureText(String(Math.round(s))).width, 0);
        ctx.restore();
        ctx.textBaseline = 'top';
      }
    }
  };

  const drawSelection = () => {
    const sel = api.getSelection();
    for (const path of sel) {
      const info = layout.get(path);
      if (!info) continue;
      const a = toScreen(info.rect.x, info.rect.y);
      const w = info.rect.w * zoom, h = info.rect.h * zoom;
      ctx.strokeStyle = info.managed ? 'rgba(230, 180, 90, 0.95)' : 'rgba(110, 175, 230, 0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
    }
    // Handles and anchor pins only for a single, freely-positioned selection.
    const info = sel.length === 1 ? layout.get(sel[0]) : null;
    if (!info || info.managed || info.kind !== 'control') return;
    const a = toScreen(info.rect.x, info.rect.y);
    const w = info.rect.w * zoom, h = info.rect.h * zoom;
    ctx.fillStyle = 'rgba(20, 24, 30, 1)';
    ctx.strokeStyle = 'rgba(110, 175, 230, 1)';
    for (const hd of HANDLES) {
      const hx = a.x + w * hd.x - HANDLE / 2, hy = a.y + h * hd.y - HANDLE / 2;
      ctx.fillRect(hx, hy, HANDLE, HANDLE);
      ctx.strokeRect(hx + 0.5, hy + 0.5, HANDLE - 1, HANDLE - 1);
    }
    drawAnchorPins(info);
  };

  // The four anchor points, drawn as triangles on the parent's rect the way
  // Godot's editor shows them.
  const drawAnchorPins = (info) => {
    const parent = parentRectOf(info);
    if (!parent) return;
    const [al, at, ar, ab] = info.anchors || [];
    if (al === undefined) return;
    const pin = (x, y) => {
      const p = toScreen(x, y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x + 5, p.y); ctx.lineTo(p.x, p.y + 5); ctx.lineTo(p.x - 5, p.y);
      ctx.closePath();
      ctx.fillStyle = 'rgba(230, 180, 90, 0.9)';
      ctx.fill();
    };
    pin(parent.x + parent.w * al, parent.y + parent.h * at);
    pin(parent.x + parent.w * ar, parent.y + parent.h * ab);
  };

  const parentRectOf = (info) => {
    const path = info.path;
    if (path === '.') return null;
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
    const p = layout.get(parentPath);
    return p ? p.rect : null;
  };

  const drawGuides = () => {
    if (!guides.xs.length && !guides.ys.length) return;
    ctx.strokeStyle = 'rgba(230, 120, 160, 0.9)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const x of guides.xs) { const p = toScreen(x, 0).x; ctx.moveTo(p + 0.5, 0); ctx.lineTo(p + 0.5, canvas.clientHeight); }
    for (const y of guides.ys) { const p = toScreen(0, y).y; ctx.moveTo(0, p + 0.5); ctx.lineTo(canvas.clientWidth, p + 0.5); }
    ctx.stroke();
    ctx.setLineDash([]);
  };

  const draw = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(14, 15, 18, 1)';
    ctx.fillRect(0, 0, w, h);
    drawGrid(w, h);
    drawViewportFrame();

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    for (const info of layout.values()) {
      if (!info.visible || info.kind === 'other') continue;
      ctx.save();
      if (info.clipRect) {
        ctx.beginPath();
        ctx.rect(info.clipRect.x, info.clipRect.y, info.clipRect.w, info.clipRect.h);
        ctx.clip();
      }
      const rot = info.rotation || 0;
      const sc = info.scale || { x: 1, y: 1 };
      if (rot || sc.x !== 1 || sc.y !== 1) {
        const px = info.rect.x + (info.pivot?.x || 0), py = info.rect.y + (info.pivot?.y || 0);
        ctx.translate(px, py);
        ctx.rotate(rot);
        ctx.scale(sc.x, sc.y);
        ctx.translate(-px, -py);
      }
      painter.draw(ctx, info);
      ctx.restore();
    }
    ctx.restore();

    drawGuides();
    drawSelection();
    if (marquee) {
      ctx.strokeStyle = 'rgba(110, 175, 230, 0.9)';
      ctx.fillStyle = 'rgba(110, 175, 230, 0.12)';
      const r = normalized(marquee);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
    }
    drawRulers(w, h);
  };

  const normalized = (m) => ({
    x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1),
    w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0),
  });

  const refresh = () => { relayout(); draw(); };

  // --- gestures ---
  let drag = null;
  let spaceDown = false;

  const handleAt = (sx, sy) => {
    const sel = api.getSelection();
    if (sel.length !== 1) return null;
    const info = layout.get(sel[0]);
    if (!info || info.managed || info.kind !== 'control') return null;
    const a = toScreen(info.rect.x, info.rect.y);
    const w = info.rect.w * zoom, h = info.rect.h * zoom;
    for (const hd of HANDLES) {
      const hx = a.x + w * hd.x, hy = a.y + h * hd.y;
      if (Math.abs(sx - hx) <= HANDLE && Math.abs(sy - hy) <= HANDLE) return { handle: hd, info };
    }
    return null;
  };

  const onPointerDown = (e) => {
    canvas.focus();
    const p = eventPos(e);
    if (p.x < RULER || p.y < RULER) return;
    if (e.button === 1 || (e.button === 0 && (spaceDown || e.altKey && e.shiftKey))) {
      drag = { kind: 'pan', x: p.x, y: p.y, panX, panY };
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;

    const grab = handleAt(p.x, p.y);
    if (grab) {
      api.beginGesture('resize');
      drag = { kind: 'resize', handle: grab.handle, path: grab.info.path, start: p, rect: { ...grab.info.rect } };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    const scene = toScene(p.x, p.y);
    const hit = pickAt(layout, scene.x, scene.y);
    const sel = api.getSelection();
    if (!hit) {
      if (!e.shiftKey && !e.ctrlKey) api.setSelection([]);
      drag = { kind: 'marquee', x0: p.x, y0: p.y, x1: p.x, y1: p.y, additive: e.shiftKey || e.ctrlKey, base: sel };
      marquee = drag;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (e.shiftKey || e.ctrlKey) {
      api.setSelection(sel.includes(hit) ? sel.filter((s) => s !== hit) : [...sel, hit]);
    } else if (!sel.includes(hit)) {
      api.setSelection([hit]);
    }
    const moving = api.getSelection().filter((s) => { const i = layout.get(s); return i && !i.managed && s !== '.'; });
    if (moving.length) {
      drag = {
        kind: 'move', start: p, moved: false,
        items: moving.map((s) => ({ path: s, rect: { ...layout.get(s).rect } })),
      };
      canvas.setPointerCapture(e.pointerId);
    }
  };

  const onPointerMove = (e) => {
    const p = eventPos(e);
    if (!drag) {
      const grab = handleAt(p.x, p.y);
      canvas.style.cursor = grab ? grab.handle.cursor : (spaceDown ? 'grab' : 'default');
      return;
    }
    if (drag.kind === 'pan') {
      panX = drag.panX + (p.x - drag.x);
      panY = drag.panY + (p.y - drag.y);
      draw();
      return;
    }
    if (drag.kind === 'marquee') {
      drag.x1 = p.x; drag.y1 = p.y;
      const r = normalized(drag);
      const a = toScene(r.x, r.y), b = toScene(r.x + r.w, r.y + r.h);
      const inside = pickInRect(layout, { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
      api.setSelection(drag.additive ? [...new Set([...drag.base, ...inside])] : inside);
      draw();
      return;
    }
    const dx = (p.x - drag.start.x) / zoom, dy = (p.y - drag.start.y) / zoom;
    if (drag.kind === 'move') {
      if (!drag.moved) {
        if (Math.abs(p.x - drag.start.x) < 3 && Math.abs(p.y - drag.start.y) < 3) return;
        drag.moved = true;
        api.beginGesture('move');
      }
      const paths = drag.items.map((i) => i.path);
      const targets = snapTargets(layout, paths, api.getViewportSize());
      let sdx = dx, sdy = dy;
      if (!e.altKey) {
        const lead = drag.items[0];
        const moved = { x: lead.rect.x + dx, y: lead.rect.y + dy, w: lead.rect.w, h: lead.rect.h };
        const snapped = snapRect(moved, targets, SNAP_TOL / zoom);
        sdx += snapped.rect.x - moved.x;
        sdy += snapped.rect.y - moved.y;
        guides = snapped.guides;
      } else guides = { xs: [], ys: [] };
      if (snapToGrid) { sdx = Math.round((drag.items[0].rect.x + sdx) / gridStep) * gridStep - drag.items[0].rect.x; sdy = Math.round((drag.items[0].rect.y + sdy) / gridStep) * gridStep - drag.items[0].rect.y; }
      for (const item of drag.items) {
        api.applyRect(item.path, { x: item.rect.x + sdx, y: item.rect.y + sdy, w: item.rect.w, h: item.rect.h });
      }
      refresh();
      return;
    }
    if (drag.kind === 'resize') {
      const id = drag.handle.id;
      const r = { ...drag.rect };
      if (id.includes('w')) { r.x = drag.rect.x + dx; r.w = drag.rect.w - dx; }
      if (id.includes('e')) { r.w = drag.rect.w + dx; }
      if (id.includes('n')) { r.y = drag.rect.y + dy; r.h = drag.rect.h - dy; }
      if (id.includes('s')) { r.h = drag.rect.h + dy; }
      if (r.w < 0) { r.x += r.w; r.w = -r.w; }
      if (r.h < 0) { r.y += r.h; r.h = -r.h; }
      if (snapToGrid) {
        r.x = Math.round(r.x / gridStep) * gridStep;
        r.y = Math.round(r.y / gridStep) * gridStep;
        r.w = Math.round(r.w / gridStep) * gridStep;
        r.h = Math.round(r.h / gridStep) * gridStep;
      }
      guides = { xs: [], ys: [] };
      api.applyRect(drag.path, r);
      refresh();
    }
  };

  const endDrag = (e) => {
    if (!drag) return;
    const kind = drag.kind;
    const moved = drag.moved;
    drag = null;
    marquee = null;
    guides = { xs: [], ys: [] };
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (kind === 'resize') api.commitGesture('resize');
    else if (kind === 'move' && moved) api.commitGesture('move');
    draw();
  };

  const onWheel = (e) => {
    e.preventDefault();
    const p = eventPos(e);
    const before = toScene(p.x, p.y);
    const factor = Math.pow(1.0015, -e.deltaY);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
    const after = toScene(p.x, p.y);
    panX += (after.x - before.x) * zoom;
    panY += (after.y - before.y) * zoom;
    draw();
    api.onZoom?.(zoom);
  };

  const onKeyDown = (e) => { if (e.code === 'Space') spaceDown = true; };
  const onKeyUp = (e) => { if (e.code === 'Space') spaceDown = false; };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // Fit the design viewport into the visible area with a small margin.
  const zoomToFit = () => {
    const v = api.getViewportSize();
    const w = Math.max(1, wrap.clientWidth - RULER - 40), h = Math.max(1, wrap.clientHeight - RULER - 40);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(w / v.width, h / v.height)));
    panX = RULER + 20 + (w - v.width * zoom) / 2;
    panY = RULER + 20 + (h - v.height * zoom) / 2;
    draw();
    api.onZoom?.(zoom);
  };

  const setZoom = (z, { center = true } = {}) => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const mid = toScene(w / 2, h / 2);
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    if (center) {
      const after = toScene(w / 2, h / 2);
      panX += (after.x - mid.x) * zoom;
      panY += (after.y - mid.y) * zoom;
    }
    draw();
    api.onZoom?.(zoom);
  };

  relayout();
  resize();
  requestAnimationFrame(zoomToFit);

  return {
    wrap,
    refresh,
    draw,
    relayout,
    getLayout: () => layout,
    getZoom: () => zoom,
    setZoom,
    zoomToFit,
    setGrid: (opts) => {
      if (opts.show !== undefined) showGrid = opts.show;
      if (opts.step !== undefined) gridStep = Math.max(1, opts.step);
      if (opts.snap !== undefined) snapToGrid = opts.snap;
      draw();
    },
    getGrid: () => ({ show: showGrid, step: gridStep, snap: snapToGrid }),
    destroy: () => {
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('keyup', onKeyUp);
      wrap.remove();
    },
  };
}
