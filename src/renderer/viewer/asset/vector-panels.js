import { assetBtn } from './ui.js';

// The vector editor's right-hand dock: a Style section bound to the current
// selection, Arrange / Path button rows, and a Layers list. The buildMaterialSection
// analogue from model-editor.js — `bindSelection(items)` re-points the style inputs
// at the selection (hiding inapplicable rows), `rebuildLayers()` repopulates the
// list after a structural edit. Structural operations are delegated to `actions`
// (supplied by vector-editor.js); plain style edits are applied here against the
// live items and committed through `ctx`.
export function createPanels(ctx, actions) {
  const dock = document.createElement('div');
  dock.className = 'vector-dock';

  const section = (title) => {
    const s = document.createElement('div'); s.className = 'vector-section';
    const h = document.createElement('div'); h.className = 'vector-section-title'; h.textContent = title;
    const b = document.createElement('div'); b.className = 'vector-section-body';
    s.append(h, b); dock.appendChild(s); return b;
  };
  const row = (...kids) => { const r = document.createElement('div'); r.className = 'vector-row'; r.append(...kids); return r; };
  const label = (text, el) => { const l = document.createElement('label'); l.className = 'vector-field'; const s = document.createElement('span'); s.className = 'vector-field-label'; s.textContent = text; l.append(s, el); return l; };

  const applyToSelection = (fn) => { const sel = ctx.getSelection(); if (!sel.length) return; for (const it of sel) fn(it); ctx.commit(); bindSelection(sel); };

  // ---- Style ----
  const styleBody = section('Style');
  const empty = document.createElement('div'); empty.className = 'vector-empty'; empty.textContent = 'Select an object to edit its style';
  const styleWrap = document.createElement('div'); styleWrap.className = 'vector-style';

  const fillType = sel('Fill', ['Solid', 'Linear', 'Radial', 'None'], (v) => onFillType(v));
  const fillColor = picker(() => applyFill());
  const fillColor2 = picker(() => applyFill());
  const gradAngle = range(0, 360, 0, () => applyFill());
  const fillColor2Row = label('Stop 2', fillColor2);
  const gradAngleRow = label('Angle', gradAngle);

  const strokeOn = check(true, () => applyStroke());
  const strokeColor = picker(() => applyStroke());
  const strokeWidth = number(0, 200, 1, () => applyStroke());
  const strokeCap = sel('Cap', ['butt', 'round', 'square'], () => applyToSelection((it) => { it.strokeCap = strokeCap.value; }));
  const strokeJoin = sel('Join', ['miter', 'round', 'bevel'], () => applyToSelection((it) => { it.strokeJoin = strokeJoin.value; }));
  const dash = textInput('e.g. 4 2', () => applyToSelection((it) => { it.dashArray = parseDash(dash.value); }));

  const opacity = range(0, 100, 100, () => applyToSelection((it) => { it.opacity = Number(opacity.value) / 100; }));
  const blend = sel('Blend', BLEND_MODES, () => applyToSelection((it) => { it.blendMode = blend.value; }));
  const corner = number(0, 1000, 0, () => applyToSelection((it) => { if (it.className === 'Shape' && it.type === 'rectangle') it.radius = new ctx.scope.Size(Number(corner.value), Number(corner.value)); }));
  const cornerRow = label('Corner', corner);

  styleWrap.append(
    label('Fill', fillType.el), label('Color', fillColor), fillColor2Row, gradAngleRow,
    row(check(true, null, 'sep')), // visual spacer row holder replaced below
  );
  // Replace the placeholder spacer with proper stroke controls.
  styleWrap.lastChild.remove();
  const strokeColorRow = label('Stroke', strokeColor);
  styleWrap.append(
    row(strokeOn, document.createTextNode(' Stroke')),
    strokeColorRow,
    label('Width', strokeWidth), strokeCap.row, strokeJoin.row, label('Dash', dash),
    label('Opacity', opacity), blend.row, cornerRow,
  );
  styleBody.append(empty, styleWrap);

  function onFillType(v) {
    fillColor2Row.style.display = (v === 'Linear' || v === 'Radial') ? '' : 'none';
    gradAngleRow.style.display = (v === 'Linear') ? '' : 'none';
    applyFill();
  }
  function applyFill() {
    const type = fillType.value;
    applyToSelection((it) => {
      if (type === 'None') { it.fillColor = null; return; }
      if (type === 'Solid') { it.fillColor = fillColor.value; return; }
      const b = it.bounds, center = b.center, scope = ctx.scope;
      let origin, destination;
      if (type === 'Radial') { origin = center; destination = new scope.Point(b.right, center.y); }
      else { const rad = Number(gradAngle.value) * Math.PI / 180; const dx = Math.cos(rad) * b.width / 2, dy = Math.sin(rad) * b.height / 2; origin = center.subtract(new scope.Point(dx, dy)); destination = center.add(new scope.Point(dx, dy)); }
      it.fillColor = { gradient: { stops: [[fillColor.value, 0], [fillColor2.value, 1]], radial: type === 'Radial' }, origin, destination };
    });
  }
  function applyStroke() {
    applyToSelection((it) => {
      if (!strokeOn.checked) { it.strokeColor = null; return; }
      it.strokeColor = strokeColor.value;
      it.strokeWidth = Number(strokeWidth.value);
    });
  }

  function bindSelection(sel) {
    const has = sel && sel.length > 0;
    empty.style.display = has ? 'none' : '';
    styleWrap.style.display = has ? '' : 'none';
    if (!has) return;
    const it = sel[0];
    // Fill
    const fc = it.fillColor;
    if (!fc) { fillType.value = 'None'; }
    else if (fc.gradient) { fillType.value = fc.gradient.radial ? 'Radial' : 'Linear'; const stops = fc.gradient.stops; if (stops[0]) fillColor.value = stops[0].color.toCSS(true); if (stops[1]) fillColor2.value = stops[1].color.toCSS(true); }
    else { fillType.value = 'Solid'; fillColor.value = fc.toCSS(true); }
    onFillTypeVisibility();
    // Stroke
    strokeOn.checked = !!it.strokeColor;
    if (it.strokeColor) strokeColor.value = it.strokeColor.toCSS(true);
    strokeWidth.value = it.strokeWidth || 0;
    if (it.strokeCap) strokeCap.value = it.strokeCap;
    if (it.strokeJoin) strokeJoin.value = it.strokeJoin;
    dash.value = (it.dashArray && it.dashArray.length) ? it.dashArray.join(' ') : '';
    opacity.value = Math.round((it.opacity != null ? it.opacity : 1) * 100);
    blend.value = it.blendMode || 'normal';
    const isRect = it.className === 'Shape' && it.type === 'rectangle';
    cornerRow.style.display = isRect ? '' : 'none';
    if (isRect) corner.value = Math.round(it.radius ? (it.radius.width || 0) : 0);
  }
  function onFillTypeVisibility() {
    const v = fillType.value;
    fillColor2Row.style.display = (v === 'Linear' || v === 'Radial') ? '' : 'none';
    gradAngleRow.style.display = (v === 'Linear') ? '' : 'none';
  }

  // ---- Arrange ----
  const arrangeBody = section('Arrange');
  arrangeBody.append(
    row(
      iconBtn('Front', 'Bring to front', () => actions.zorder('front')),
      iconBtn('▲', 'Bring forward', () => actions.zorder('forward')),
      iconBtn('▼', 'Send backward', () => actions.zorder('backward')),
      iconBtn('Back', 'Send to back', () => actions.zorder('back')),
    ),
    row(
      assetBtn('Group', () => actions.group()),
      assetBtn('Ungroup', () => actions.ungroup()),
      assetBtn('Duplicate', () => actions.duplicate()),
      assetBtn('Delete', () => actions.remove()),
    ),
    row(
      iconBtn('⇤', 'Align left', () => actions.align('left')),
      iconBtn('⇔', 'Align horizontal centers', () => actions.align('hcenter')),
      iconBtn('⇥', 'Align right', () => actions.align('right')),
      iconBtn('⤒', 'Align top', () => actions.align('top')),
      iconBtn('⇕', 'Align vertical centers', () => actions.align('vcenter')),
      iconBtn('⤓', 'Align bottom', () => actions.align('bottom')),
    ),
    row(
      assetBtn('Dist H', () => actions.align('dist-h')),
      assetBtn('Dist V', () => actions.align('dist-v')),
      iconBtn('Flip H', 'Flip horizontal', () => actions.flip('h')),
      iconBtn('Flip V', 'Flip vertical', () => actions.flip('v')),
      iconBtn('⟲', 'Rotate 90° left', () => actions.rotate90(-1)),
      iconBtn('⟳', 'Rotate 90° right', () => actions.rotate90(1)),
    ),
  );

  // ---- Path ----
  const pathBody = section('Path');
  pathBody.append(
    row(
      assetBtn('Unite', () => actions.boolean('unite')),
      assetBtn('Intersect', () => actions.boolean('intersect')),
      assetBtn('Subtract', () => actions.boolean('subtract')),
    ),
    row(
      assetBtn('Exclude', () => actions.boolean('exclude')),
      assetBtn('Divide', () => actions.boolean('divide')),
    ),
    row(
      assetBtn('Join', () => actions.pathOp('join')),
      assetBtn('Close', () => actions.pathOp('close')),
      assetBtn('Reverse', () => actions.pathOp('reverse')),
    ),
    row(
      assetBtn('Simplify', () => actions.pathOp('simplify')),
      assetBtn('Smooth', () => actions.pathOp('smooth')),
      assetBtn('Flatten', () => actions.pathOp('flatten')),
    ),
  );

  // ---- Layers ----
  const layersBody = section('Layers');
  const layersHead = row(assetBtn('+ Layer', () => actions.addLayer()));
  const layersList = document.createElement('div'); layersList.className = 'vector-layers';
  layersBody.append(layersHead, layersList);

  function rebuildLayers() {
    layersList.innerHTML = '';
    const tree = actions.getTree();
    for (const layer of tree) {
      layersList.appendChild(layerRow(layer, true));
      for (const item of layer.items) layersList.appendChild(layerRow(item, false));
    }
  }
  function layerRow(node, isLayer) {
    const r = document.createElement('div');
    r.className = 'vector-layer-row' + (isLayer ? ' is-layer' : '') + (node.active || node.selected ? ' sel' : '');
    const eye = miniBtn(node.visible ? '👁' : '◌', 'Toggle visibility', (e) => { e.stopPropagation(); actions.toggleVisible(node.ref); });
    const lock = miniBtn(node.locked ? '🔒' : '🔓', 'Toggle lock', (e) => { e.stopPropagation(); actions.toggleLocked(node.ref); });
    const name = document.createElement('span'); name.className = 'vector-layer-name'; name.textContent = node.name;
    name.title = 'Double-click to rename';
    name.ondblclick = (e) => { e.stopPropagation(); renameInline(name, node); };
    const up = miniBtn('▲', 'Raise', (e) => { e.stopPropagation(); actions.raise(node.ref); });
    const down = miniBtn('▼', 'Lower', (e) => { e.stopPropagation(); actions.lower(node.ref); });
    const del = miniBtn('✕', 'Delete', (e) => { e.stopPropagation(); actions.removeNode(node.ref, isLayer); });
    r.append(eye, lock, name, up, down, del);
    r.onclick = () => actions.selectNode(node.ref, isLayer);
    return r;
  }
  function renameInline(nameEl, node) {
    const inp = document.createElement('input'); inp.className = 'vector-rename'; inp.value = node.name;
    nameEl.replaceWith(inp); inp.focus(); inp.select();
    const done = () => { actions.rename(node.ref, inp.value.trim() || node.name); rebuildLayers(); };
    inp.onblur = done;
    inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); else if (e.key === 'Escape') { inp.value = node.name; inp.blur(); } };
  }

  bindSelection([]);
  return { element: dock, bindSelection, rebuildLayers };

  // ---- small DOM builders ----
  function picker(onchange) { const i = document.createElement('input'); i.type = 'color'; i.className = 'asset-picker'; i.value = '#000000'; i.oninput = onchange; return i; }
  function number(min, max, val, onchange) { const i = document.createElement('input'); i.type = 'number'; i.className = 'vector-num'; i.min = min; i.max = max; i.value = val; i.oninput = onchange; return i; }
  function range(min, max, val, onchange) { const i = document.createElement('input'); i.type = 'range'; i.className = 'vector-range'; i.min = min; i.max = max; i.value = val; i.oninput = onchange; return i; }
  function textInput(ph, onchange) { const i = document.createElement('input'); i.type = 'text'; i.className = 'vector-text'; i.placeholder = ph; i.onchange = onchange; return i; }
  function check(val, onchange) { const i = document.createElement('input'); i.type = 'checkbox'; i.className = 'vector-check'; i.checked = val; if (onchange) i.onchange = onchange; return i; }
  function sel(labelText, opts, onchange) {
    const s = document.createElement('select'); s.className = 'vector-select';
    for (const o of opts) { const op = document.createElement('option'); op.value = (typeof o === 'string') ? o.toLowerCase() : o; op.textContent = o; s.appendChild(op); }
    s.onchange = onchange;
    const r = label(labelText, s);
    return { el: s, row: r, get value() { return s.value; }, set value(v) { s.value = String(v).toLowerCase(); } };
  }
  function iconBtn(text, title, onclick) { const b = assetBtn(text, onclick); b.title = title; return b; }
  function miniBtn(text, title, onclick) { const b = document.createElement('button'); b.className = 'vector-mini'; b.textContent = text; b.title = title; b.onclick = onclick; return b; }
}

const BLEND_MODES = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];

function parseDash(s) {
  const nums = (s || '').trim().split(/[\s,]+/).map(Number).filter((n) => isFinite(n) && n >= 0);
  return nums.length ? nums : [];
}
