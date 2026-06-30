// Pointer tools for the vector editor, isolating all paper.js hit-testing and
// gesture logic from the editor shell. The editor drives a single paper Tool whose
// handlers delegate to whichever tool is active; each tool here is a factory
// `(ctx) => toolObject` with optional onActivate/onDeactivate/onMouseDown/Drag/Up/
// Move/onDouble/refresh handlers. `ctx` (built by vector-editor.js) is the bridge to
// the live document: scope/view, selection, current style, snapshot commit, the
// overlay (uiLayer) for handles, hit-testing, and text editing.
//
// Pan/zoom is NOT a tool — the editor handles it natively (wheel + middle/Hand drag
// in screen space) so it never fights a left-button tool gesture.

const ACCENT = (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0e639c');

// Walk up from a hit child to the top-level content item (direct child of a layer),
// so clicking a grouped shape selects the whole group.
function topLevel(item, scope) {
  let it = item;
  while (it.parent && !(it.parent instanceof scope.Layer)) it = it.parent;
  return it;
}

function combinedBounds(items) {
  let b = null;
  for (const it of items) b = b ? b.unite(it.bounds) : it.bounds.clone();
  return b;
}

// --- transform box: selection outline + 8 scale handles + a rotate knob ---
// Lives on the overlay layer (never exported). Rebuilt on every selection/zoom
// change so handles stay a constant on-screen size.
function makeTransformBox(ctx) {
  const scope = ctx.scope;
  let group = null, box = null, handles = [], rotate = null;

  const clear = () => { if (group) group.remove(); group = null; handles = []; box = null; rotate = null; };

  const update = () => {
    clear();
    const sel = ctx.getSelection();
    if (!sel.length) return;
    const b = combinedBounds(sel);
    if (!b || !isFinite(b.width)) return;
    const z = ctx.view.zoom;
    const hs = 4 / z; // handle half-size, constant on screen
    group = new scope.Group();

    const outline = new scope.Path.Rectangle(b);
    outline.strokeColor = ACCENT; outline.strokeWidth = 1 / z; outline.dashArray = [3 / z, 2 / z]; outline.fillColor = null;
    group.addChild(outline);

    const pts = handlePoints(b, scope);
    for (const key of Object.keys(pts)) {
      const h = new scope.Path.Rectangle(new scope.Rectangle(pts[key].x - hs, pts[key].y - hs, hs * 2, hs * 2));
      h.fillColor = 'white'; h.strokeColor = ACCENT; h.strokeWidth = 1 / z; h.data.handle = key;
      group.addChild(h); handles.push(h);
    }
    const top = new scope.Point(b.center.x, b.top);
    const knob = new scope.Point(b.center.x, b.top - 22 / z);
    const stem = new scope.Path.Line(top, knob); stem.strokeColor = ACCENT; stem.strokeWidth = 1 / z;
    rotate = new scope.Path.Circle(knob, hs * 1.3); rotate.fillColor = 'white'; rotate.strokeColor = ACCENT; rotate.strokeWidth = 1 / z; rotate.data.handle = 'rotate';
    group.addChild(stem); group.addChild(rotate);

    ctx.uiLayer.addChild(group);
    box = b;
  };

  const hitHandle = (point) => {
    const tol = ctx.hitTolerance();
    for (const h of handles) if (h.bounds.expand(tol * 2).contains(point)) return h.data.handle;
    if (rotate && rotate.bounds.expand(tol * 2).contains(point)) return 'rotate';
    return null;
  };

  return { update, clear, hitHandle, get box() { return box; } };
}

function handlePoints(b, scope) {
  const P = (x, y) => new scope.Point(x, y);
  return {
    nw: P(b.left, b.top), n: P(b.center.x, b.top), ne: P(b.right, b.top),
    e: P(b.right, b.center.y), se: P(b.right, b.bottom), s: P(b.center.x, b.bottom),
    sw: P(b.left, b.bottom), w: P(b.left, b.center.y),
  };
}

// For a grabbed scale handle: the fixed anchor (opposite point) and which axes move.
function scaleSpec(handle, b, scope) {
  const P = (x, y) => new scope.Point(x, y);
  const map = {
    nw: { anchor: P(b.right, b.bottom), x: true, y: true },
    ne: { anchor: P(b.left, b.bottom), x: true, y: true },
    se: { anchor: P(b.left, b.top), x: true, y: true },
    sw: { anchor: P(b.right, b.top), x: true, y: true },
    n: { anchor: P(b.center.x, b.bottom), x: false, y: true },
    s: { anchor: P(b.center.x, b.top), x: false, y: true },
    e: { anchor: P(b.left, b.center.y), x: true, y: false },
    w: { anchor: P(b.right, b.center.y), x: true, y: false },
  };
  return map[handle];
}

// --- select / move / scale / rotate / marquee ---
function selectTool(ctx) {
  const scope = ctx.scope;
  const tbox = makeTransformBox(ctx);
  let mode = null;        // 'move' | 'scale' | 'rotate' | 'marquee'
  let spec = null, handlePt = null, rotateCenter = null, rotatePrev = 0;
  let marquee = null, downPoint = null, moved = false;

  const refresh = () => tbox.update();

  return {
    onActivate() { for (const it of ctx.getSelection()) it.fullySelected = false; tbox.update(); },
    onDeactivate() { tbox.clear(); },
    refresh,
    onMouseDown(e) {
      moved = false; downPoint = e.point;
      const sel = ctx.getSelection();
      // 1) a transform handle (only when something is selected)
      if (sel.length) {
        const h = tbox.hitHandle(e.point);
        if (h === 'rotate') { mode = 'rotate'; rotateCenter = tbox.box.center; rotatePrev = e.point.subtract(rotateCenter).angle; return; }
        if (h) { mode = 'scale'; spec = scaleSpec(h, tbox.box, scope); handlePt = e.point; return; }
      }
      // 2) an item
      const hit = ctx.hitTest(e.point, { fill: true, stroke: true });
      if (hit) {
        const item = topLevel(hit.item, scope);
        if (e.modifiers.shift) ctx.toggleSelected(item);
        else if (!ctx.getSelection().includes(item)) ctx.setSelection([item]);
        mode = 'move'; tbox.update(); return;
      }
      // 3) empty: start a marquee (clearing selection unless extending)
      if (!e.modifiers.shift) ctx.setSelection([]);
      mode = 'marquee';
      marquee = new scope.Path.Rectangle(e.point, new scope.Size(0, 0));
      marquee.strokeColor = ACCENT; marquee.strokeWidth = 1 / ctx.view.zoom; marquee.dashArray = [3, 2]; marquee.fillColor = new scope.Color(0.05, 0.4, 0.8, 0.12);
      ctx.uiLayer.addChild(marquee);
      tbox.update();
    },
    onMouseDrag(e) {
      moved = true;
      const sel = ctx.getSelection();
      if (mode === 'move') {
        for (const it of sel) it.position = it.position.add(e.delta);
        tbox.update();
      } else if (mode === 'scale') {
        const b = tbox.box; if (!b) return;
        let fx = 1, fy = 1;
        if (spec.x) { const old = handlePt.x - spec.anchor.x; if (Math.abs(old) > 1e-6) fx = (e.point.x - spec.anchor.x) / old; }
        if (spec.y) { const old = handlePt.y - spec.anchor.y; if (Math.abs(old) > 1e-6) fy = (e.point.y - spec.anchor.y) / old; }
        if (e.modifiers.shift && spec.x && spec.y) { const f = Math.max(Math.abs(fx), Math.abs(fy)); fx = Math.sign(fx || 1) * f; fy = Math.sign(fy || 1) * f; }
        for (const it of sel) it.scale(fx, fy, spec.anchor);
        handlePt = e.point; tbox.update();
      } else if (mode === 'rotate') {
        const ang = e.point.subtract(rotateCenter).angle;
        const delta = ang - rotatePrev;
        for (const it of sel) it.rotate(delta, rotateCenter);
        rotatePrev = ang; tbox.update();
      } else if (mode === 'marquee' && marquee) {
        marquee.remove();
        const r = new scope.Rectangle(downPoint, e.point);
        marquee = new scope.Path.Rectangle(r);
        marquee.strokeColor = ACCENT; marquee.strokeWidth = 1 / ctx.view.zoom; marquee.dashArray = [3, 2]; marquee.fillColor = new scope.Color(0.05, 0.4, 0.8, 0.12);
        ctx.uiLayer.addChild(marquee);
      }
    },
    onMouseUp(e) {
      if (mode === 'marquee' && marquee) {
        const r = new scope.Rectangle(downPoint, e.point);
        const picked = ctx.contentItems().filter((it) => r.intersects(it.bounds) || r.contains(it.bounds));
        marquee.remove(); marquee = null;
        ctx.setSelection(e.modifiers.shift ? ctx.getSelection().concat(picked) : picked);
        tbox.update();
      } else if (moved && (mode === 'move' || mode === 'scale' || mode === 'rotate')) {
        ctx.commit();
      }
      mode = null; spec = null;
    },
    onDouble() {
      // Double-click a text item to edit it; otherwise enter node editing.
      const hit = ctx.hitTest(ctx.lastPoint, { fill: true, stroke: true });
      if (!hit) return;
      const item = topLevel(hit.item, scope);
      if (item.className === 'PointText') ctx.editText(item);
    },
  };
}

// --- direct node editing: drag anchor points and bezier handles ---
function nodeTool(ctx) {
  const scope = ctx.scope;
  let grabbed = null; // { segment, kind: 'point'|'in'|'out' }
  let moved = false;

  const showHandles = () => { for (const it of ctx.getSelection()) if (it.className === 'Path' || it.className === 'CompoundPath') it.fullySelected = true; };

  return {
    onActivate: showHandles,
    onDeactivate() { for (const it of ctx.getSelection()) it.fullySelected = false; },
    refresh: showHandles,
    onMouseDown(e) {
      moved = false;
      const hit = ctx.hitTest(e.point, { segments: true, handles: true, stroke: true });
      if (!hit) { ctx.setSelection([]); return; }
      const item = topLevel(hit.item, scope);
      if (!ctx.getSelection().includes(item)) { ctx.setSelection([item]); item.fullySelected = true; }
      if (hit.type === 'segment') grabbed = { segment: hit.segment, kind: 'point' };
      else if (hit.type === 'handle-in') grabbed = { segment: hit.segment, kind: 'in' };
      else if (hit.type === 'handle-out') grabbed = { segment: hit.segment, kind: 'out' };
      else grabbed = null;
    },
    onMouseDrag(e) {
      if (!grabbed) return;
      moved = true;
      const s = grabbed.segment;
      if (grabbed.kind === 'point') s.point = s.point.add(e.delta);
      else if (grabbed.kind === 'in') s.handleIn = s.handleIn.add(e.delta);
      else s.handleOut = s.handleOut.add(e.delta);
    },
    onMouseUp() { if (grabbed && moved) ctx.commit(); grabbed = null; },
  };
}

// --- pen: click for corners, click-drag for bezier handles, click start to close ---
function penTool(ctx) {
  const scope = ctx.scope;
  let path = null, lastSeg = null;

  const finalize = () => {
    if (!path) return;
    if (path.segments.length < 2) path.remove();
    else { ctx.applyNewStyle(path, 'stroke'); ctx.register(path); ctx.setSelection([path]); ctx.commit(); }
    path = null; lastSeg = null;
  };

  return {
    onDeactivate: finalize,
    onMouseDown(e) {
      const pt = ctx.snap(e.point);
      if (path && path.segments.length > 1) {
        const first = path.firstSegment.point;
        if (first.getDistance(pt) <= ctx.hitTolerance() * 2) { path.closed = true; finalize(); return; }
      }
      if (!path) { path = new scope.Path(); path.strokeColor = ctx.getStyle().stroke || ACCENT; path.strokeWidth = ctx.getStyle().strokeWidth || 1; path.fillColor = null; }
      lastSeg = path.add(pt);
    },
    onMouseDrag(e) {
      if (!lastSeg) return;
      const out = e.point.subtract(lastSeg.point);
      lastSeg.handleOut = out;
      lastSeg.handleIn = out.multiply(-1);
    },
    onDouble: finalize,
    finalize,
  };
}

// --- pencil: freehand drawing simplified to a smooth path on release ---
function pencilTool(ctx) {
  const scope = ctx.scope;
  let path = null;
  return {
    onMouseDown(e) {
      path = new scope.Path();
      path.strokeColor = ctx.getStyle().stroke || ACCENT;
      path.strokeWidth = ctx.getStyle().strokeWidth || 1;
      path.fillColor = null;
      path.add(e.point);
    },
    onMouseDrag(e) { if (path) path.add(e.point); },
    onMouseUp() {
      if (!path) return;
      if (path.segments.length < 2) path.remove();
      else { path.simplify(10); ctx.applyNewStyle(path, 'stroke'); ctx.register(path); ctx.setSelection([path]); ctx.commit(); }
      path = null;
    },
  };
}

// --- shapes: rectangle / rounded / ellipse / line / polygon / star ---
function shapeTool(ctx, kind) {
  const scope = ctx.scope;
  let start = null, item = null;

  const build = (a, b, shift) => {
    const style = ctx.getStyle();
    if (kind === 'line') {
      let end = b;
      if (shift) { const d = b.subtract(a); const ang = Math.round(d.angle / 45) * 45; end = a.add(new scope.Point({ length: d.length, angle: ang })); }
      return new scope.Path.Line(a, end);
    }
    if (kind === 'polygon' || kind === 'star') {
      const radius = Math.max(1, b.getDistance(a));
      if (kind === 'polygon') return new scope.Path.RegularPolygon(a, style.polygonSides || 5, radius);
      return new scope.Path.Star(a, style.starPoints || 5, radius, radius * (style.starRatio || 0.5));
    }
    let rect = new scope.Rectangle(a, b);
    if (shift) { const s = Math.max(rect.width, rect.height); rect = new scope.Rectangle(a, new scope.Size(a.x <= b.x ? s : -s, a.y <= b.y ? s : -s)); }
    if (kind === 'ellipse') return new scope.Shape.Ellipse(rect);
    if (kind === 'rounded') { const r = Math.min(rect.width, rect.height) * 0.18; return new scope.Shape.Rectangle(rect, new scope.Size(r, r)); }
    return new scope.Shape.Rectangle(rect);
  };

  return {
    onMouseDown(e) { start = ctx.snap(e.point); item = null; },
    onMouseDrag(e) {
      if (item) item.remove();
      item = build(start, ctx.snap(e.point), e.modifiers.shift);
      ctx.applyNewStyle(item, kind === 'line' ? 'stroke' : 'shape');
    },
    onMouseUp() {
      if (!item) { start = null; return; }
      const tiny = item.bounds.width < 1 && item.bounds.height < 1;
      if (tiny) item.remove();
      else { ctx.register(item); ctx.setSelection([item]); ctx.commit(); }
      item = null; start = null;
    },
  };
}

// --- text: place a PointText and open the inline editor ---
function textTool(ctx) {
  const scope = ctx.scope;
  return {
    onMouseDown(e) {
      const style = ctx.getStyle();
      const t = new scope.PointText({
        point: ctx.snap(e.point),
        content: 'Text',
        fillColor: style.fill || '#000000',
        fontFamily: style.fontFamily || 'sans-serif',
        fontSize: style.fontSize || 24,
      });
      ctx.register(t); ctx.setSelection([t]); ctx.commit();
      ctx.editText(t);
    },
  };
}

// --- eyedropper: copy a clicked item's fill/stroke into the current style ---
function eyedropperTool(ctx) {
  return {
    onMouseDown(e) {
      const hit = ctx.hitTest(e.point, { fill: true, stroke: true });
      if (!hit) return;
      const it = hit.item;
      ctx.setStyle({
        fill: it.fillColor ? it.fillColor.toCSS(true) : null,
        stroke: it.strokeColor ? it.strokeColor.toCSS(true) : null,
        strokeWidth: it.strokeWidth || ctx.getStyle().strokeWidth,
      });
    },
  };
}

// --- bucket: set a clicked item's fill to the current fill ---
function bucketTool(ctx) {
  return {
    onMouseDown(e) {
      const hit = ctx.hitTest(e.point, { fill: true, stroke: true });
      if (!hit) return;
      hit.item.fillColor = ctx.getStyle().fill;
      ctx.commit();
    },
  };
}

// --- eraser: delete items under the pointer (click or drag) ---
function eraserTool(ctx) {
  const scope = ctx.scope;
  let removed = false;
  const eraseAt = (point) => {
    const hit = ctx.hitTest(point, { fill: true, stroke: true });
    if (hit) { topLevel(hit.item, scope).remove(); removed = true; }
  };
  return {
    onMouseDown(e) { removed = false; eraseAt(e.point); },
    onMouseDrag(e) { eraseAt(e.point); },
    onMouseUp() { if (removed) { ctx.setSelection([]); ctx.commit(); } },
  };
}

export function createTools(ctx) {
  return {
    select: selectTool(ctx),
    node: nodeTool(ctx),
    pen: penTool(ctx),
    pencil: pencilTool(ctx),
    rect: shapeTool(ctx, 'rect'),
    rounded: shapeTool(ctx, 'rounded'),
    ellipse: shapeTool(ctx, 'ellipse'),
    line: shapeTool(ctx, 'line'),
    polygon: shapeTool(ctx, 'polygon'),
    star: shapeTool(ctx, 'star'),
    text: textTool(ctx),
    eyedropper: eyedropperTool(ctx),
    bucket: bucketTool(ctx),
    eraser: eraserTool(ctx),
  };
}
