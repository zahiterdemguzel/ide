import { loadPaper, createCanvas, importSvg, exportSvg, zoomAt, fitView } from './vector-paper.js';
import { createTools } from './vector-tools.js';
import { createPanels } from './vector-panels.js';
import { assetBtn } from './ui.js';
import { base64ToText, textToBase64 } from '../../shared/base64.js';
import { parseSvgSize, applySvgSize, ensureSvgXmlns, alignOffsets, bringToFront, sendToBack, forwardOne, backwardOne } from '../../shared/svg-ops.js';
import { refreshGit } from '../../git-pane.js';

// The SVG vector editor — the model-editor.js analogue. Orchestrates the paper.js
// canvas (vector-paper.js), the pointer tools (vector-tools.js) and the dock panels
// (vector-panels.js) behind a single `ctx` (the tools' bridge) and `actions` (the
// panels' structural operations). Save re-exports the project to SVG, re-stamps the
// document's original size, and writes it back. Undo/redo is a project.exportJSON()
// snapshot ring (paper has no built-in undo) — robust against the structural edits
// (booleans, grouping) that exact inverse closures would be fragile for.
//
// Overlay UI (transform handles, marquee) lives on a dedicated `uiLayer` that is
// pulled out of the project for every export/snapshot, so it never leaks into the
// saved SVG or an undo state. Reached only through index.js's coordinator, which
// dynamically imports this module, so paper.js costs nothing until Edit is pressed.
export function renderVectorEditor(file, base64, ext, body, tools, registerCleanup) {
  // --- header chrome (built synchronously; the coordinator hides everything else) ---
  const status = document.createElement('span');
  status.className = 'asset-pct';
  let saving = false, dirty = false;
  const setStatus = (t) => { status.textContent = t; };
  const refreshSave = () => { saveBtn.disabled = !dirty || saving; };
  const markDirty = () => { dirty = true; setStatus(''); refreshSave(); };
  const saveBtn = assetBtn('Save', () => save());
  saveBtn.classList.add('adjust-apply');
  saveBtn.title = 'Save changes back to the file (Ctrl+S)';
  tools.append(saveBtn, status);

  const loading = document.createElement('div');
  loading.className = 'vector-loading';
  loading.textContent = 'Loading editor…';
  body.appendChild(loading);

  let core = null, keyHandler = null, disposed = false;
  registerCleanup(() => {
    disposed = true;
    if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
    if (core) core.dispose();
  });

  const originalSize = parseSvgSize(safeText(base64));

  // Everything past the paper load lives in one closure so `ctx`/`actions` methods
  // can reference the editor's local state directly.
  loadPaper().then((paper) => {
    if (disposed) return;
    loading.remove();
    buildEditor(paper);
  }).catch((e) => {
    loading.remove();
    body.textContent = 'Could not open vector editor: ' + (e && e.message ? e.message : e);
  });

  function safeText(b64) { try { return base64ToText(b64); } catch { return ''; } }

  function buildEditor(paper) {
    // --- layout: left tool rail · center canvas · right dock ---
    const editor = document.createElement('div');
    editor.className = 'vector-editor';
    const rail = document.createElement('div');
    rail.className = 'vector-toolbar';
    const stageHost = document.createElement('div');
    stageHost.className = 'vector-stage-host';
    editor.append(rail, stageHost);
    body.appendChild(editor);

    core = createCanvas(paper, stageHost);
    const { scope, project, view } = core;
    scope.activate();
    core.render = () => view.update();

    // Import artwork into the initial layer, then add a separate overlay layer on
    // top for transform handles. Keep a content layer active so new items land in
    // the artwork, never the overlay.
    const root = importSvg(scope, safeText(base64));
    let activeContentLayer = project.activeLayer;
    const uiLayer = new scope.Layer();
    activeContentLayer.activate();

    const contentActivate = () => { if (activeContentLayer && !activeContentLayer.isInserted?.()) activeContentLayer = project.layers.find((l) => l !== uiLayer) || new scope.Layer(); activeContentLayer.activate(); uiLayer.bringToFront(); };

    // Run `fn` with the overlay removed from the project, so exports/snapshots never
    // capture handles. Re-attaches the overlay (on top) and restores the active layer.
    const withoutUI = (fn) => {
      uiLayer.remove();
      try { return fn(); }
      finally { project.addLayer(uiLayer); uiLayer.bringToFront(); activeContentLayer.activate(); }
    };

    // --- current drawing style for new items (the panel edits selections directly) ---
    const style = {
      fill: '#4a90d9', stroke: '#1e1e1e', strokeWidth: 1,
      fontFamily: 'sans-serif', fontSize: 24,
      polygonSides: 5, starPoints: 5, starRatio: 0.5,
    };

    // --- grid snap (off by default) ---
    let snapOn = false; const gridStep = 10;

    // --- selection helpers ---
    const isContent = (it) => it && it.layer !== uiLayer;
    const getSelection = () => project.selectedItems.filter(isContent);
    const setSelection = (items) => {
      for (const it of project.selectedItems) it.selected = false;
      for (const it of items) if (it) { it.selected = true; }
      afterSelection();
    };
    const toggleSelected = (item) => { item.selected = !item.selected; afterSelection(); };

    let panels = null, toolMap = null, active = null;
    const afterSelection = () => {
      if (active && active.refresh) active.refresh();
      if (panels) panels.bindSelection(getSelection());
      core.render();
    };

    // --- undo/redo snapshot ring (exportJSON, overlay excluded) ---
    const undoStack = [], redoStack = [];
    let baseline = withoutUI(() => project.exportJSON());
    const restore = (json) => {
      uiLayer.remove();
      project.clear();
      project.importJSON(json);
      project.addLayer(uiLayer);
      activeContentLayer = project.layers.find((l) => l !== uiLayer) || new scope.Layer();
      contentActivate();
      refreshAll();
    };
    const commit = () => {
      undoStack.push(baseline);
      if (undoStack.length > 40) undoStack.shift();
      redoStack.length = 0;
      baseline = withoutUI(() => project.exportJSON());
      markDirty();
      if (panels) { panels.bindSelection(getSelection()); panels.rebuildLayers(); }
      if (active && active.refresh) active.refresh();
      core.render();
    };
    const undo = () => { if (!undoStack.length) return; redoStack.push(baseline); baseline = undoStack.pop(); restore(baseline); markDirty(); };
    const redo = () => { if (!redoStack.length) return; undoStack.push(baseline); baseline = redoStack.pop(); restore(baseline); markDirty(); };

    const refreshAll = () => {
      if (panels) { panels.bindSelection(getSelection()); panels.rebuildLayers(); }
      if (active && active.refresh) active.refresh();
      core.render();
    };

    // --- the tools' ctx bridge ---
    let uidCounter = 0;
    const ctx = {
      scope, view, uiLayer,
      lastPoint: new scope.Point(0, 0),
      getSelection, setSelection, toggleSelected,
      contentItems: () => project.layers.filter((l) => l !== uiLayer).flatMap((l) => l.children.slice()),
      getStyle: () => style,
      setStyle: (partial) => { Object.assign(style, partial); },
      applyNewStyle: (item, kind) => {
        if (kind === 'stroke' || kind === 'line') { item.strokeColor = style.stroke; item.strokeWidth = style.strokeWidth; item.fillColor = null; }
        else { item.fillColor = style.fill; item.strokeColor = style.stroke; item.strokeWidth = style.strokeWidth; }
      },
      register: (item) => { item.data = item.data || {}; item.data.uid = ++uidCounter; },
      snap: (pt) => { if (!snapOn) return pt; return new scope.Point(Math.round(pt.x / gridStep) * gridStep, Math.round(pt.y / gridStep) * gridStep); },
      hitTolerance: () => 6 / view.zoom,
      hitTest: (point, opts) => project.hitTest(point, { ...opts, tolerance: 6 / view.zoom, match: (h) => isContent(h.item) && !h.item.locked }),
      editText,
      commit,
    };

    // --- structural operations (the panels' actions) ---
    const combinedCenter = (sel) => { let b = null; for (const it of sel) b = b ? b.unite(it.bounds) : it.bounds.clone(); return b ? b.center : null; };
    const applyOrder = (container, order) => { const snap = container.children.slice(); for (const i of order) container.addChild(snap[i]); };
    const reorderItem = (item, op) => {
      const parent = item.parent; if (!parent) return;
      const order = Array.from({ length: parent.children.length }, (_, i) => i);
      const from = item.index;
      const next = op === 'front' ? bringToFront(order, from) : op === 'back' ? sendToBack(order, from) : op === 'forward' ? forwardOne(order, from) : backwardOne(order, from);
      applyOrder(parent, next);
    };
    const toPath = (item) => { if (item.className === 'Shape') { const p = item.toPath(true); item.remove(); return p; } return item; };

    const actions = {
      zorder: (which) => { const sel = getSelection(); if (!sel.length) return; for (const it of sel) reorderItem(it, which); commit(); },
      group: () => { const sel = getSelection(); if (sel.length < 2) return; const g = new scope.Group(sel); ctx.register(g); setSelection([g]); commit(); },
      ungroup: () => {
        const sel = getSelection(); let any = false; const out = [];
        for (const it of sel) { if (it.className === 'Group') { const kids = it.removeChildren(); it.parent.insertChildren(it.index, kids); it.remove(); out.push(...kids); any = true; } else out.push(it); }
        if (any) { setSelection(out); commit(); }
      },
      duplicate: () => { const sel = getSelection(); if (!sel.length) return; const clones = sel.map((it) => { const c = it.clone(); ctx.register(c); c.position = c.position.add(new scope.Point(12, 12)); return c; }); setSelection(clones); commit(); },
      remove: () => { const sel = getSelection(); if (!sel.length) return; for (const it of sel) it.remove(); setSelection([]); commit(); },
      align: (mode) => {
        const sel = getSelection(); if (sel.length < 2) return;
        const deltas = alignOffsets(sel.map((it) => ({ x: it.bounds.x, y: it.bounds.y, width: it.bounds.width, height: it.bounds.height })), mode);
        sel.forEach((it, i) => { it.position = it.position.add(new scope.Point(deltas[i].dx, deltas[i].dy)); });
        commit();
      },
      flip: (axis) => { const sel = getSelection(); if (!sel.length) return; const c = combinedCenter(sel); for (const it of sel) it.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1, c); commit(); },
      rotate90: (dir) => { const sel = getSelection(); if (!sel.length) return; const c = combinedCenter(sel); for (const it of sel) it.rotate(90 * dir, c); commit(); },
      boolean: (op) => {
        const sel = getSelection().filter((it) => it.className === 'Path' || it.className === 'CompoundPath' || it.className === 'Shape');
        if (sel.length < 2) return;
        const paths = sel.map(toPath);
        let acc = paths[0];
        for (let i = 1; i < paths.length; i++) { const next = acc[op](paths[i]); if (i > 1) acc.remove(); acc = next; }
        for (const p of paths) p.remove();
        ctx.register(acc); setSelection([acc]); commit();
      },
      pathOp: (op) => {
        const sel = getSelection().filter((it) => it.className === 'Path' || it.className === 'CompoundPath');
        if (!sel.length) return;
        if (op === 'join' && sel.length >= 2) { const a = sel[0]; for (let i = 1; i < sel.length; i++) a.join(sel[i]); setSelection([a]); commit(); return; }
        for (const it of sel) {
          if (op === 'close') it.closed = true;
          else if (op === 'reverse') it.reverse();
          else if (op === 'simplify') it.simplify(10);
          else if (op === 'smooth') it.smooth();
          else if (op === 'flatten') it.flatten(2);
        }
        commit();
      },
      addLayer: () => { const L = new scope.Layer(); L.name = 'Layer ' + project.layers.filter((l) => l !== uiLayer).length; activeContentLayer = L; uiLayer.bringToFront(); commit(); },
      getTree: () => project.layers.filter((l) => l !== uiLayer).map((l) => ({
        name: l.name || 'Layer', visible: l.visible, locked: l.locked, active: l === activeContentLayer, ref: l,
        items: l.children.slice().reverse().map((it) => ({ name: it.name || (it.className + (it.data && it.data.uid ? ' ' + it.data.uid : '')), visible: it.visible, locked: it.locked, selected: it.selected, ref: it })),
      })),
      toggleVisible: (ref) => { ref.visible = !ref.visible; commit(); },
      toggleLocked: (ref) => { ref.locked = !ref.locked; if (panels) panels.rebuildLayers(); },
      raise: (ref) => { if (ref instanceof scope.Layer) reorderLayer(ref, 'forward'); else reorderItem(ref, 'forward'); commit(); },
      lower: (ref) => { if (ref instanceof scope.Layer) reorderLayer(ref, 'backward'); else reorderItem(ref, 'backward'); commit(); },
      removeNode: (ref) => { if (ref === activeContentLayer) activeContentLayer = project.layers.find((l) => l !== uiLayer && l !== ref) || activeContentLayer; ref.remove(); commit(); },
      selectNode: (ref, isLayer) => { if (isLayer) { activeContentLayer = ref; ref.activate(); uiLayer.bringToFront(); if (panels) panels.rebuildLayers(); } else setSelection([ref]); },
      rename: (ref, name) => { ref.name = name; },
    };

    const reorderLayer = (layer, op) => {
      // Reorder among content layers only; the overlay always stays on top.
      const content = project.layers.filter((l) => l !== uiLayer);
      const from = content.indexOf(layer);
      if (from < 0) return;
      const order = Array.from({ length: content.length }, (_, i) => i);
      const next = op === 'forward' ? forwardOne(order, from) : backwardOne(order, from);
      for (const i of next) project.addLayer(content[i]);
      uiLayer.bringToFront();
    };

    // --- panels + tools ---
    panels = createPanels(ctx, actions);
    editor.appendChild(panels.element);
    toolMap = createTools(ctx);

    // --- single paper Tool, delegating to the active tool ---
    const paperTool = new scope.Tool();
    const dispatch = (name, e) => { ctx.lastPoint = e.point; if (active && active[name]) active[name](e); core.render(); };
    paperTool.onMouseDown = (e) => dispatch('onMouseDown', e);
    paperTool.onMouseDrag = (e) => dispatch('onMouseDrag', e);
    paperTool.onMouseMove = (e) => { ctx.lastPoint = e.point; if (active && active.onMouseMove) active.onMouseMove(e); };
    paperTool.onMouseUp = (e) => dispatch('onMouseUp', e);

    const setActiveTool = (name) => {
      if (!toolMap[name]) return;
      if (active && active.onDeactivate) active.onDeactivate();
      active = toolMap[name];
      if (active.onActivate) active.onActivate();
      for (const b of rail.children) if (b.dataset.tool) b.classList.toggle('on', b.dataset.tool === name);
      core.canvas.style.cursor = CURSORS[name] || 'default';
      core.render();
    };
    const finalizeActive = () => { if (active && active.finalize) active.finalize(); };

    // --- tool rail ---
    for (const t of TOOLBAR) {
      if (t === '-') { const sep = document.createElement('div'); sep.className = 'vector-tool-sep'; rail.appendChild(sep); continue; }
      const b = document.createElement('button');
      b.className = 'vector-tool'; b.dataset.tool = t.name; b.textContent = t.icon;
      b.title = `${t.label} (${t.key.toUpperCase()})`;
      b.onclick = () => setActiveTool(t.name);
      rail.appendChild(b);
    }
    // Extra rail controls: grid snap toggle + fit view.
    const gridBtn = document.createElement('button');
    gridBtn.className = 'vector-tool'; gridBtn.textContent = '#'; gridBtn.title = 'Toggle grid snap';
    gridBtn.onclick = () => { snapOn = !snapOn; gridBtn.classList.toggle('on', snapOn); };
    const fitBtn = document.createElement('button');
    fitBtn.className = 'vector-tool'; fitBtn.textContent = '⤢'; fitBtn.title = 'Fit artwork to view';
    fitBtn.onclick = () => { fitView(scope, contentBounds()); if (active && active.refresh) active.refresh(); };
    const railSep = document.createElement('div'); railSep.className = 'vector-tool-sep';
    rail.append(railSep, gridBtn, fitBtn);

    const contentBounds = () => { const items = ctx.contentItems(); let b = null; for (const it of items) b = b ? b.unite(it.bounds) : it.bounds.clone(); return b ? { bounds: b } : null; };

    // --- pan (middle drag) + zoom (wheel) in screen space ---
    let panning = false, lastPan = null;
    core.canvas.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 1) return;
      ev.preventDefault(); core.canvas.setPointerCapture(ev.pointerId);
      panning = true; lastPan = { x: ev.clientX, y: ev.clientY };
    });
    core.canvas.addEventListener('pointermove', (ev) => {
      if (!panning) return;
      const dx = ev.clientX - lastPan.x, dy = ev.clientY - lastPan.y;
      lastPan = { x: ev.clientX, y: ev.clientY };
      view.center = view.center.subtract(new scope.Point(dx / view.zoom, dy / view.zoom));
      if (active && active.refresh) active.refresh();
      core.render();
    });
    const endPan = (ev) => { if (ev.button === 1) panning = false; };
    core.canvas.addEventListener('pointerup', endPan);
    core.canvas.addEventListener('pointercancel', () => { panning = false; });
    core.canvas.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });
    core.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    core.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const rect = core.canvas.getBoundingClientRect();
      const projPoint = view.viewToProject(new scope.Point(ev.clientX - rect.left, ev.clientY - rect.top));
      zoomAt(scope, ev.deltaY < 0 ? 1.1 : 1 / 1.1, projPoint);
      if (active && active.refresh) active.refresh();
    }, { passive: false });

    // --- double-click → text edit / node entry (paper Tool has no double event) ---
    core.canvas.addEventListener('dblclick', (ev) => {
      const rect = core.canvas.getBoundingClientRect();
      ctx.lastPoint = view.viewToProject(new scope.Point(ev.clientX - rect.left, ev.clientY - rect.top));
      if (active && active.onDouble) active.onDouble();
    });

    // --- inline text editor overlay ---
    function editText(item) {
      const vp = view.projectToView(item.point);
      const input = document.createElement('input');
      input.className = 'vector-text-edit';
      input.value = item.content;
      input.style.left = vp.x + 'px';
      input.style.top = (vp.y - (item.fontSize || 16)) + 'px';
      core.wrap.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const finish = (keep) => { if (done) return; done = true; if (keep && input.value !== item.content) { item.content = input.value; commit(); } input.remove(); };
      input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
      input.onblur = () => finish(true);
    }

    // --- keyboard ---
    keyHandler = (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); save(); }
        else if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
        else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
        else if (k === 'g' && !e.shiftKey) { e.preventDefault(); actions.group(); }
        else if (k === 'g' && e.shiftKey) { e.preventDefault(); actions.ungroup(); }
        else if (k === 'd') { e.preventDefault(); actions.duplicate(); }
        else if (k === 'a') { e.preventDefault(); setSelection(ctx.contentItems()); }
        return;
      }
      if (typing) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actions.remove(); return; }
      if (e.key === 'Escape') { finalizeActive(); setSelection([]); return; }
      if (e.key === 'Enter') { finalizeActive(); return; }
      if (e.key === '[') { actions.zorder('backward'); return; }
      if (e.key === ']') { actions.zorder('forward'); return; }
      const name = KEYMAP[e.key.toLowerCase()];
      if (name) setActiveTool(name);
    };
    document.addEventListener('keydown', keyHandler, true);

    // --- save: export → re-stamp size → write ---
    async function save() {
      if (!dirty || saving) return;
      saving = true; refreshSave(); setStatus('Saving…');
      try {
        let svg = withoutUI(() => exportSvg(scope));
        svg = ensureSvgXmlns(applySvgSize(svg, originalSize));
        const r = await window.api.writeAsset(file, textToBase64(svg));
        saving = false;
        if (r.ok) { dirty = false; setStatus('Saved'); refreshGit(); }
        else setStatus(r.error || 'Save failed');
      } catch (err) {
        saving = false;
        setStatus('Export failed: ' + (err && err.message ? err.message : err));
      }
      refreshSave();
    }
    // Expose save to the header button + Ctrl+S (both call this closure).
    saveImpl = save;

    // --- go ---
    setActiveTool('select');
    refreshAll();
    refreshSave();
    // Frame after layout so the canvas has its real size (viewSize is 0 pre-layout).
    requestAnimationFrame(() => {
      if (disposed || !core) return;
      core.resize();
      fitView(scope, root || contentBounds());
      if (active && active.refresh) active.refresh();
    });
  }

  // The header Save button is wired before buildEditor runs; route it through here.
  let saveImpl = null;
  function save() { if (saveImpl) saveImpl(); }
}

// Tool rail layout. icon is a compact glyph; key is the keyboard shortcut.
const TOOLBAR = [
  { name: 'select', icon: '▲', label: 'Select / move', key: 'v' },
  { name: 'node', icon: '✎', label: 'Edit nodes', key: 'a' },
  '-',
  { name: 'pen', icon: '✒', label: 'Pen', key: 'p' },
  { name: 'pencil', icon: '✐', label: 'Pencil', key: 'n' },
  '-',
  { name: 'rect', icon: '▭', label: 'Rectangle', key: 'r' },
  { name: 'rounded', icon: '▢', label: 'Rounded rect', key: 'u' },
  { name: 'ellipse', icon: '◯', label: 'Ellipse', key: 'o' },
  { name: 'line', icon: '╱', label: 'Line', key: 'l' },
  { name: 'polygon', icon: '⬠', label: 'Polygon', key: 'y' },
  { name: 'star', icon: '★', label: 'Star', key: 's' },
  { name: 'text', icon: 'T', label: 'Text', key: 't' },
  '-',
  { name: 'eyedropper', icon: '⚲', label: 'Eyedropper', key: 'k' },
  { name: 'bucket', icon: '▣', label: 'Fill', key: 'b' },
  { name: 'eraser', icon: '⌫', label: 'Eraser', key: 'e' },
];

const KEYMAP = Object.fromEntries(TOOLBAR.filter((t) => t !== '-').map((t) => [t.key, t.name]));

const CURSORS = {
  select: 'default', node: 'default', pen: 'crosshair', pencil: 'crosshair',
  rect: 'crosshair', rounded: 'crosshair', ellipse: 'crosshair', line: 'crosshair',
  polygon: 'crosshair', star: 'crosshair', text: 'text', eyedropper: 'crosshair',
  bucket: 'crosshair', eraser: 'cell',
};
