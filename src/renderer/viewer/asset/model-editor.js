import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { base64ToArrayBuffer, arrayBufferToBase64 } from '../../shared/base64.js';
import { ADJUSTMENTS, DEFAULTS, isNeutral, applyAdjustments } from '../../shared/adjust-ops.js';
import { enumerateTextures } from '../../shared/model-textures.js';
import {
  createViewer, loadModel, frameObject,
  applyColliderWireframe, addEmptyMarkers, buildHierarchy,
  isPrimitiveGroup, isMeshPrimitive, copyPrimitiveTags,
} from './model-scene.js';
import { assetBtn } from './ui.js';
import { refreshGit } from '../../git-pane.js';

// 3D editor mode for glTF/GLB models. Built on the same shared scene core as the
// read-only viewer (model-scene.js), plus: a transform gizmo (TransformControls),
// a floating edit dock with transform-mode/node/material/texture controls, an
// undo/redo command stack, and a Save pipeline that re-exports the live model
// through GLTFExporter back into the file. The header carries only a Save button
// (the coordinator hides the rest); Ctrl+S saves too. Save enables only after the
// first edit. Reached only through index.js's coordinator, which dynamically
// imports this module, so three.js + the exporter never cost app startup.
export function renderModelEditor(file, base64, ext, body, tools, registerCleanup) {
  const viewer = createViewer(body);
  const { scene, camera, renderer, controls } = viewer;
  const buffer = base64ToArrayBuffer(base64);

  // --- header: Save + status (the only chrome in edit mode) ---
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

  // --- undo/redo command stack ---
  // Each command is { undo, redo }; the closures do whatever a step needs (set a
  // transform, restore slider values, rebuild the tree after a structural edit).
  const undoStack = [], redoStack = [];
  const pushCommand = (cmd) => { undoStack.push(cmd); redoStack.length = 0; markDirty(); };
  const undo = () => { const c = undoStack.pop(); if (!c) return; c.undo(); redoStack.push(c); markDirty(); };
  const redo = () => { const c = redoStack.pop(); if (!c) return; c.redo(); undoStack.push(c); markDirty(); };

  // --- transform gizmo ---
  const gizmo = new TransformControls(camera, renderer.domElement);
  // Move/rotate/scale around the object's own origin and axes (local space), not
  // the world/parent frame — the expected behaviour when editing a single part.
  gizmo.setSpace('local');
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });

  // One undo entry per gizmo gesture: snapshot on press, compare on release.
  let dragObj = null, dragBefore = null;
  const snapXform = (o) => ({ position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() });
  const applyXform = (o, s) => { o.position.copy(s.position); o.quaternion.copy(s.quaternion); o.scale.copy(s.scale); };
  const sameXform = (a, b) => a.position.equals(b.position) && a.quaternion.equals(b.quaternion) && a.scale.equals(b.scale);
  gizmo.addEventListener('mouseDown', () => { dragObj = gizmo.object; dragBefore = dragObj && snapXform(dragObj); });
  gizmo.addEventListener('mouseUp', () => {
    if (!dragObj || !dragBefore) return;
    const o = dragObj, before = dragBefore, after = snapXform(o);
    dragObj = null; dragBefore = null;
    if (sameXform(before, after)) return;
    pushCommand({ undo: () => applyXform(o, before), redo: () => applyXform(o, after) });
  });

  let modelRoot = null; // the exported root (the loaded glTF scene)
  let outliner = null;

  const setMode = (mode) => {
    gizmo.setMode(mode);
    for (const m in modeButtons) modeButtons[m].classList.toggle('on', m === mode);
  };

  // --- edit dock (built once, populated as selection changes) ---
  const dock = document.createElement('div');
  dock.className = 'model-edit-panel';
  const dockHead = document.createElement('button');
  dockHead.className = 'model-tree-head';
  dockHead.title = 'Toggle editor panel';
  dockHead.innerHTML = '<span class="model-tree-caret">▾</span><span class="model-tree-title">Editor</span>';
  dockHead.addEventListener('click', () => dock.classList.toggle('collapsed'));
  const dockBody = document.createElement('div');
  dockBody.className = 'model-edit-body';
  dock.append(dockHead, dockBody);

  const section = (title) => {
    const s = document.createElement('div');
    s.className = 'model-edit-section';
    const h = document.createElement('div');
    h.className = 'model-edit-section-title';
    h.textContent = title;
    const b = document.createElement('div');
    b.className = 'model-edit-section-body';
    s.append(h, b);
    dockBody.appendChild(s);
    return b;
  };

  // Transform section: mode switch (also W/E/R).
  const transformBody = section('Transform');
  const modeButtons = {
    translate: assetBtn('Move', () => setMode('translate')),
    rotate: assetBtn('Rotate', () => setMode('rotate')),
    scale: assetBtn('Scale', () => setMode('scale')),
  };
  modeButtons.translate.title = 'Move (W)';
  modeButtons.rotate.title = 'Rotate (E)';
  modeButtons.scale.title = 'Scale (R)';
  const transformRow = document.createElement('div');
  transformRow.className = 'model-edit-row';
  transformRow.append(modeButtons.translate, modeButtons.rotate, modeButtons.scale);
  transformBody.appendChild(transformRow);

  // Node section: duplicate / delete the selected node.
  const nodeBody = section('Node');
  const dupBtn = assetBtn('Duplicate', () => duplicateSelected());
  const delBtn = assetBtn('Delete', () => deleteSelected());
  const nodeRow = document.createElement('div');
  nodeRow.className = 'model-edit-row';
  nodeRow.append(dupBtn, delBtn);
  nodeBody.appendChild(nodeRow);

  // Material section: base color / metalness / roughness / emissive of the
  // selected mesh's material (first slot for a multi-material mesh).
  const matUI = buildMaterialSection(section('Material'), pushCommand, () => matState).controls;
  let matState = null; // { material }

  // Texture section: pick a base-color texture and adjust it like the image editor.
  const textureBody = section('Texture');
  const texSelect = document.createElement('select');
  texSelect.className = 'model-edit-select';
  const texEmpty = document.createElement('div');
  texEmpty.className = 'model-edit-empty';
  texEmpty.textContent = 'No editable textures';
  const texSliders = document.createElement('div');
  texSliders.className = 'model-edit-sliders';
  const texRows = [];
  for (const a of ADJUSTMENTS) {
    const row = document.createElement('label');
    row.className = 'adjust-row';
    const name = document.createElement('span'); name.className = 'adjust-name'; name.textContent = a.label;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '-100'; slider.max = '100'; slider.value = '0';
    slider.className = 'adjust-slider';
    const val = document.createElement('span'); val.className = 'adjust-val'; val.textContent = '0';
    slider.addEventListener('input', () => {
      const n = Number(slider.value);
      if (currentEntry) currentEntry.values[a.key] = n;
      val.textContent = (n > 0 ? '+' : '') + n;
      val.classList.toggle('changed', n !== 0);
      scheduleTexRender();
    });
    slider.addEventListener('change', () => commitTexture());
    slider.addEventListener('dblclick', () => { slider.value = '0'; slider.dispatchEvent(new Event('input')); commitTexture(); });
    row.append(name, slider, val);
    texSliders.appendChild(row);
    texRows.push({ key: a.key, slider, val });
  }
  const texResetBtn = assetBtn('Reset texture', () => {
    if (!currentEntry) return;
    for (const r of texRows) { r.slider.value = '0'; r.slider.dispatchEvent(new Event('input')); }
    commitTexture();
  });
  textureBody.append(texSelect, texEmpty, texSliders, texResetBtn);
  // Hidden until the model loads and refreshTextureList() decides what to show.
  texSelect.style.display = 'none'; texEmpty.style.display = 'none';
  texSliders.style.display = 'none'; texResetBtn.style.display = 'none';
  texSelect.addEventListener('change', () => selectTexture(textureEntries[texSelect.selectedIndex]));

  let textureEntries = [];
  let currentEntry = null;
  let texRaf = 0, texQueued = false;

  const scheduleTexRender = () => { if (!texQueued) { texQueued = true; texRaf = requestAnimationFrame(renderTexture); } };
  const renderTexture = () => {
    texQueued = false;
    const e = currentEntry;
    if (!e || !e.srcData) return;
    if (isNeutral(e.values)) { e.texture.image = e.originalImage; }
    else {
      applyAdjustments(e.srcData.data, e.out.data, e.values);
      e.editCtx.putImageData(e.out, 0, 0);
      e.texture.image = e.editCanvas;
    }
    e.texture.needsUpdate = true;
  };

  // Commit a texture-adjust gesture (slider release / reset) as one undo entry,
  // capturing the value delta against the last committed state.
  const commitTexture = () => {
    const e = currentEntry;
    if (!e) return;
    const before = e.committed, after = { ...e.values };
    if (ADJUSTMENTS.every((a) => before[a.key] === after[a.key])) return;
    e.committed = after;
    pushCommand({
      undo: () => setTextureValues(e, before),
      redo: () => setTextureValues(e, after),
    });
  };
  const setTextureValues = (e, vals) => {
    e.values = { ...vals };
    e.committed = { ...vals };
    renderTextureFor(e);
    if (currentEntry === e) syncTexSliders();
  };
  // Render a specific entry even if it isn't the one in the panel (undo/redo).
  const renderTextureFor = (e) => {
    if (!e.srcData) return;
    if (isNeutral(e.values)) { e.texture.image = e.originalImage; }
    else {
      applyAdjustments(e.srcData.data, e.out.data, e.values);
      e.editCtx.putImageData(e.out, 0, 0);
      e.texture.image = e.editCanvas;
    }
    e.texture.needsUpdate = true;
  };
  const syncTexSliders = () => {
    const v = currentEntry ? currentEntry.values : DEFAULTS;
    for (const r of texRows) {
      const n = v[r.key] || 0;
      r.slider.value = String(n);
      r.val.textContent = (n > 0 ? '+' : '') + n;
      r.val.classList.toggle('changed', n !== 0);
    }
  };

  // Lazily read a texture's source pixels once and prepare its edit canvas.
  const ensureEntry = (e) => {
    if (e.srcData || e.unusable) return !e.unusable;
    const image = e.texture.image;
    const w = image && (image.naturalWidth || image.width);
    const h = image && (image.naturalHeight || image.height);
    if (!w || !h) { e.unusable = true; return false; }
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sctx = src.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(image, 0, 0);
    e.srcData = sctx.getImageData(0, 0, w, h);
    e.out = new ImageData(w, h);
    e.editCanvas = document.createElement('canvas'); e.editCanvas.width = w; e.editCanvas.height = h;
    e.editCtx = e.editCanvas.getContext('2d');
    e.originalImage = image;
    if (!e.values) { e.values = { ...DEFAULTS }; e.committed = { ...DEFAULTS }; }
    return true;
  };
  const selectTexture = (e) => {
    currentEntry = e || null;
    const ok = e && ensureEntry(e);
    texSliders.style.display = ok ? '' : 'none';
    texResetBtn.style.display = ok ? '' : 'none';
    if (ok) syncTexSliders();
  };

  // Re-enumerate textures after a structural edit; keep the current selection if
  // the same texture survives, otherwise fall back to the first.
  const refreshTextureList = () => {
    const prev = currentEntry && currentEntry.texture;
    const fresh = enumerateTextures(modelRoot);
    // Carry over any in-progress edit session bound to a surviving texture.
    for (const e of fresh) {
      const old = textureEntries.find((o) => o.texture === e.texture);
      if (old) Object.assign(e, { srcData: old.srcData, out: old.out, editCanvas: old.editCanvas, editCtx: old.editCtx, originalImage: old.originalImage, values: old.values, committed: old.committed, unusable: old.unusable });
    }
    textureEntries = fresh;
    texSelect.innerHTML = '';
    for (const e of fresh) {
      const opt = document.createElement('option');
      opt.textContent = e.label;
      texSelect.appendChild(opt);
    }
    const has = fresh.length > 0;
    texSelect.style.display = has ? '' : 'none';
    texEmpty.style.display = has ? 'none' : '';
    if (!has) { selectTexture(null); return; }
    const keepIdx = prev ? fresh.findIndex((e) => e.texture === prev) : -1;
    const idx = keepIdx >= 0 ? keepIdx : 0;
    texSelect.selectedIndex = idx;
    selectTexture(fresh[idx]);
  };

  // --- selection → gizmo + panels ---
  const updateSelection = (obj) => {
    if (obj) gizmo.attach(obj); else gizmo.detach();
    const isRoot = obj === modelRoot;
    dupBtn.disabled = !obj || isRoot || !obj.parent;
    delBtn.disabled = !obj || isRoot || !obj.parent;
    // Material panel reflects the selected mesh's (first) material. A folded
    // multi-material mesh (primitive group) edits its first primitive's material.
    const meshForMat = obj && (obj.isMesh ? obj : (isPrimitiveGroup(obj) ? obj.children.find((c) => c.isMesh) : null));
    const mat = meshForMat && (Array.isArray(meshForMat.material) ? meshForMat.material[0] : meshForMat.material);
    matState = mat && mat.color ? { material: mat } : null;
    matUI.bind(matState ? matState.material : null);
  };

  const reselect = (obj) => { outliner.rebuild(); if (obj) outliner.selectObject(obj); updateSelection(outliner.getSelected()); refreshTextureList(); };

  const duplicateSelected = () => {
    const obj = outliner.getSelected();
    if (!obj || obj === modelRoot || !obj.parent) return;
    const parent = obj.parent;
    const clone = obj.clone(true);
    copyPrimitiveTags(obj, clone); // keep a folded multi-material mesh folded
    parent.add(clone);
    pushCommand({
      undo: () => { parent.remove(clone); reselect(obj); },
      redo: () => { parent.add(clone); reselect(clone); },
    });
    reselect(clone);
  };
  const deleteSelected = () => {
    const obj = outliner.getSelected();
    if (!obj || obj === modelRoot || !obj.parent) return;
    const parent = obj.parent;
    parent.remove(obj);
    pushCommand({
      undo: () => { parent.add(obj); reselect(obj); },
      redo: () => { parent.remove(obj); reselect(null); },
    });
    reselect(null);
  };
  const reparent = (child, newParent) => {
    const oldParent = child.parent;
    if (!oldParent || oldParent === newParent) return;
    newParent.attach(child); // attach preserves the child's world transform
    pushCommand({
      undo: () => { oldParent.attach(child); reselect(child); },
      redo: () => { newParent.attach(child); reselect(child); },
    });
    reselect(child);
  };

  // --- click a part in the viewport to select it (→ gizmo + panels) ---
  // Raycast the model on a click that wasn't a gizmo grab or an orbit drag. A hit
  // rolls up to its selectable node (a folded primitive group, else the mesh) and
  // a miss deselects; selection runs through the outliner so its row, the bounding
  // box, the gizmo and the panels all stay in sync.
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const isPickable = (o) => {
    for (let n = o; n; n = n.parent) { if (!n.visible) return false; if (n === modelRoot) break; }
    return true;
  };
  const pickAt = (clientX, clientY) => {
    if (!modelRoot || !outliner) return;
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObject(modelRoot, true)) {
      if (hit.object.userData.isEmptyMarker || !isPickable(hit.object)) continue;
      outliner.selectObject(isMeshPrimitive(hit.object) ? hit.object.parent : hit.object);
      return;
    }
    outliner.deselect();
  };

  // Distinguish a pick (press + release in place) from an orbit drag or a gizmo grab.
  let downX = 0, downY = 0, downOnGizmo = false;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    downX = e.clientX; downY = e.clientY;
    downOnGizmo = !!gizmo.axis;
  };
  const onPointerUp = (e) => {
    if (e.button !== 0 || downOnGizmo || gizmo.dragging) return;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (dx * dx + dy * dy > 25) return; // moved enough to be an orbit drag, not a pick
    pickAt(e.clientX, e.clientY);
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // --- load the model and wire everything up ---
  const onLoaded = (object) => {
    modelRoot = object;
    // A framing pivot absorbs frameObject's recentring offset so the exported
    // model root keeps its own (pristine) transform — only user/gizmo edits change it.
    const pivot = new THREE.Group();
    pivot.add(object);
    scene.add(pivot);
    applyColliderWireframe(object);
    frameObject(pivot, camera, controls, viewer.grid);
    const markers = addEmptyMarkers(object);
    outliner = buildHierarchy(object, viewer.wrap, controls, scene, markers, {
      editable: true,
      onSelect: updateSelection,
      onReparent: reparent,
    });
    refreshTextureList();
    updateSelection(null);
    setMode('translate');
    viewer.resize();
    viewer.start();
  };
  const onError = (e) => {
    viewer.wrap.classList.add('model-err');
    viewer.wrap.textContent = 'Could not load model: ' + (e && e.message ? e.message : e);
  };
  Promise.resolve().then(() => loadModel(ext, buffer)).then(onLoaded).catch(onError);
  viewer.wrap.appendChild(dock);

  // --- save: re-export the live model root → file ---
  async function save() {
    if (!dirty || saving || !modelRoot) return;
    saving = true; refreshSave(); setStatus('Saving…');

    // Empty-marker crosses are children of model nodes; strip them so they don't
    // export as junk LineSegments, then restore after.
    const detached = [];
    modelRoot.traverse((o) => { if (o.userData.isEmptyMarker) detached.push([o, o.parent]); });
    for (const [marker, parent] of detached) parent && parent.remove(marker);

    try {
      const result = await new GLTFExporter().parseAsync(modelRoot, { binary: ext === 'glb', onlyVisible: false });
      const bytes = ext === 'glb' ? result : new TextEncoder().encode(JSON.stringify(result));
      const out64 = arrayBufferToBase64(bytes);
      const r = await window.api.writeAsset(file, out64);
      saving = false;
      if (r.ok) { dirty = false; setStatus('Saved'); refreshGit(); }
      else { setStatus(r.error || 'Save failed'); }
    } catch (err) {
      saving = false;
      setStatus('Export failed: ' + (err && err.message ? err.message : err));
    } finally {
      for (const [marker, parent] of detached) parent && parent.add(marker);
      refreshSave();
    }
  }

  // --- keyboard: Ctrl+S save, Ctrl+Z/Y undo/redo, W/E/R mode, Delete node ---
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save(); }
      else if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      return;
    }
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = e.key.toLowerCase();
    if (k === 'w') setMode('translate');
    else if (k === 'e') setMode('rotate');
    else if (k === 'r') setMode('scale');
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  };
  document.addEventListener('keydown', onKey, true);

  refreshSave();
  registerCleanup(() => {
    cancelAnimationFrame(texRaf);
    document.removeEventListener('keydown', onKey, true);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    gizmo.detach();
    scene.remove(gizmo.getHelper());
    gizmo.dispose();
    viewer.dispose();
  });
}

// The Material section's controls: base color, metalness, roughness, emissive.
// Returns `{ body, controls }` where `controls.bind(material|null)` re-points the
// inputs at a material (hiding the section when none / not a standard material).
// `getState()` exposes the current `{ material }` so undo/redo can re-sync inputs.
function buildMaterialSection(body, pushCommand, getState) {
  const empty = document.createElement('div');
  empty.className = 'model-edit-empty';
  empty.textContent = 'Select a mesh to edit its material';

  const wrap = document.createElement('div');
  wrap.className = 'model-edit-mat';

  const hexOf = (c) => '#' + c.getHexString();
  const snap = (m) => ({
    color: hexOf(m.color),
    emissive: m.emissive ? hexOf(m.emissive) : null,
    metalness: typeof m.metalness === 'number' ? m.metalness : null,
    roughness: typeof m.roughness === 'number' ? m.roughness : null,
  });
  const apply = (m, s) => {
    m.color.set(s.color);
    if (s.emissive && m.emissive) m.emissive.set(s.emissive);
    if (s.metalness !== null && typeof m.metalness === 'number') m.metalness = s.metalness;
    if (s.roughness !== null && typeof m.roughness === 'number') m.roughness = s.roughness;
    m.needsUpdate = true;
  };

  let material = null, committed = null;
  const commit = () => {
    if (!material) return;
    // Capture the specific material now — `material` is reassigned when the
    // selection changes, so the undo/redo closures must not read it live.
    const m = material;
    const after = snap(m);
    if (JSON.stringify(after) === JSON.stringify(committed)) return;
    const before = committed; committed = after;
    pushCommand({
      undo: () => { apply(m, before); if (getState() && getState().material === m) sync(); },
      redo: () => { apply(m, after); if (getState() && getState().material === m) sync(); },
    });
  };

  const colorInput = document.createElement('input');
  colorInput.type = 'color'; colorInput.className = 'asset-picker';
  colorInput.addEventListener('input', () => { if (material) { material.color.set(colorInput.value); material.needsUpdate = true; } });
  colorInput.addEventListener('change', commit);

  const emissiveInput = document.createElement('input');
  emissiveInput.type = 'color'; emissiveInput.className = 'asset-picker';
  emissiveInput.addEventListener('input', () => { if (material && material.emissive) { material.emissive.set(emissiveInput.value); material.needsUpdate = true; } });
  emissiveInput.addEventListener('change', commit);

  const colorRow = matRow('Color', colorInput);
  const emissiveRow = matRow('Emissive', emissiveInput);

  const mkSlider = (label, set) => {
    const row = document.createElement('label'); row.className = 'adjust-row';
    const name = document.createElement('span'); name.className = 'adjust-name'; name.textContent = label;
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = '0'; slider.className = 'adjust-slider';
    const val = document.createElement('span'); val.className = 'adjust-val'; val.textContent = '0';
    slider.addEventListener('input', () => { const n = Number(slider.value) / 100; val.textContent = n.toFixed(2); if (material) { set(material, n); material.needsUpdate = true; } });
    slider.addEventListener('change', commit);
    row.append(name, slider, val);
    return { row, slider, val };
  };
  const metal = mkSlider('Metalness', (m, n) => { m.metalness = n; });
  const rough = mkSlider('Roughness', (m, n) => { m.roughness = n; });

  wrap.append(colorRow, emissiveRow, metal.row, rough.row);
  body.append(empty, wrap);

  const sync = () => {
    if (!material) return;
    colorInput.value = hexOf(material.color);
    if (material.emissive) { emissiveInput.value = hexOf(material.emissive); emissiveRow.style.display = ''; }
    else emissiveRow.style.display = 'none';
    if (typeof material.metalness === 'number') { metal.slider.value = String(Math.round(material.metalness * 100)); metal.val.textContent = material.metalness.toFixed(2); metal.row.style.display = ''; }
    else metal.row.style.display = 'none';
    if (typeof material.roughness === 'number') { rough.slider.value = String(Math.round(material.roughness * 100)); rough.val.textContent = material.roughness.toFixed(2); rough.row.style.display = ''; }
    else rough.row.style.display = 'none';
  };

  const bind = (m) => {
    material = m || null;
    committed = material ? snap(material) : null;
    const has = !!material;
    wrap.style.display = has ? '' : 'none';
    empty.style.display = has ? 'none' : '';
    if (has) sync();
  };

  return { body, controls: { bind } };
}

function matRow(label, input) {
  const row = document.createElement('div');
  row.className = 'model-edit-mat-row';
  const name = document.createElement('span'); name.className = 'adjust-name'; name.textContent = label;
  row.append(name, input);
  return row;
}
