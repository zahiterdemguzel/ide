import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createViewer, frameObject, buildHierarchy, addEmptyMarkers } from './model-scene.js';
import { assetBtn } from './ui.js';
import { refreshGit } from '../../git-pane.js';
import { showFile } from '../file.js';
import { hideAsset } from './index.js';
import {
  parseTscn, serializeTscn, nodeSections, nodePathOf, attrStr, getAttr, getProp,
  parseNums, parseRef, transformOfNode, setNodeTransform, addNode, removeNodeTree,
  addSubResource, uniqueChildName,
} from '../../shared/tscn.js';

// 3D editor for Godot .tscn scenes, built on the same shared scene core as the
// glTF editor (model-scene.js): outliner, orbit viewer, transform gizmo, undo/
// redo, Ctrl+S save. The parsed document (shared/tscn.js) stays the source of
// truth — the three.js graph is a live *view* of it. Every edit mutates the doc
// (so unknown node types, scripts, signals and properties survive untouched)
// and mirrors the change onto the three.js objects; Save serializes the doc
// back through write-text. Node types the viewer can't visualize (scripts,
// instanced scenes, non-primitive meshes) still appear in the outliner and get
// a placeholder in the viewport so they can be selected and transformed.

export function renderSceneEditor(file, text, body, tools, registerCleanup) {
  let doc = parseTscn(text);
  const nodes = doc.header && doc.header.tag === 'gd_scene' ? nodeSections(doc) : [];
  if (!nodes.length) {
    body.textContent = 'Not a Godot scene: no [node] sections found.';
    registerCleanup(() => {});
    return;
  }

  const viewer = createViewer(body);
  const { scene, camera, renderer, controls } = viewer;

  // --- header: Save + status + raw-text escape hatch ---
  const status = document.createElement('span');
  status.className = 'asset-pct';
  let saving = false, dirty = false;
  const setStatus = (t) => { status.textContent = t; };
  const refreshSave = () => { saveBtn.disabled = !dirty || saving; };
  const markDirty = () => { dirty = true; setStatus(''); refreshSave(); };

  const textBtn = assetBtn('Text', () => { hideAsset(); showFile(file); });
  textBtn.title = 'Open the scene as raw text';
  const saveBtn = assetBtn('Save', () => save());
  saveBtn.classList.add('adjust-apply');
  saveBtn.title = 'Save changes back to the file (Ctrl+S)';
  tools.append(textBtn, saveBtn, status);

  // --- undo/redo ---
  // Each command carries the serialized document before/after (the doc is
  // re-parsed wholesale on undo/redo — scenes are small text files) plus
  // closures that mirror the step onto the live three.js graph.
  const undoStack = [], redoStack = [];
  const pushCommand = (cmd) => { undoStack.push(cmd); redoStack.length = 0; markDirty(); };
  const undo = () => { const c = undoStack.pop(); if (!c) return; doc = parseTscn(c.before); c.undoScene(); redoStack.push(c); markDirty(); };
  const redo = () => { const c = redoStack.pop(); if (!c) return; doc = parseTscn(c.after); c.redoScene(); undoStack.push(c); markDirty(); };

  // --- doc lookups / transform conversion ---
  const subResource = (id) => doc.sections.find((s) => s.tag === 'sub_resource' && attrStr(s, 'id') === id);
  const propNum = (sec, key, def) => { const v = parseNums(getProp(sec, key) ?? ''); return v.length ? v[0] : def; };
  const propVec = (sec, key, n, defs) => { const v = parseNums(getProp(sec, key) ?? ''); return v.length === n ? v : defs; };

  // Godot's 12 Transform3D numbers are the basis rows + origin; Matrix4.set()
  // takes row-major values, so they map straight across (both are Y-up RH).
  const applyNodeTransform = (obj, nums) => {
    const [a, b, c, d, e, f, g, h, i, ox, oy, oz] = nums;
    new THREE.Matrix4()
      .set(a, b, c, ox, d, e, f, oy, g, h, i, oz, 0, 0, 0, 1)
      .decompose(obj.position, obj.quaternion, obj.scale);
  };
  const transformNums = (obj) => {
    obj.updateMatrix();
    const e = obj.matrix.elements; // column-major
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10], e[12], e[13], e[14]];
  };

  // --- building three.js objects from node sections ---

  const geometryForMesh = (sub) => {
    switch (attrStr(sub, 'type')) {
      case 'BoxMesh': { const [x, y, z] = propVec(sub, 'size', 3, [1, 1, 1]); return new THREE.BoxGeometry(x, y, z); }
      case 'SphereMesh': return new THREE.SphereGeometry(propNum(sub, 'radius', 0.5), 24, 16);
      case 'CylinderMesh': return new THREE.CylinderGeometry(propNum(sub, 'top_radius', 0.5), propNum(sub, 'bottom_radius', 0.5), propNum(sub, 'height', 2), 24);
      case 'CapsuleMesh': { const r = propNum(sub, 'radius', 0.5), h = propNum(sub, 'height', 2); return new THREE.CapsuleGeometry(r, Math.max(0, h - 2 * r), 8, 16); }
      case 'PlaneMesh': { const [x, y] = propVec(sub, 'size', 2, [2, 2]); const g = new THREE.PlaneGeometry(x, y); g.rotateX(-Math.PI / 2); return g; } // Godot's plane faces +Y
      case 'QuadMesh': { const [x, y] = propVec(sub, 'size', 2, [1, 1]); return new THREE.PlaneGeometry(x, y); }
      case 'TorusMesh': { const inner = propNum(sub, 'inner_radius', 0.5), outer = propNum(sub, 'outer_radius', 1); const g = new THREE.TorusGeometry((inner + outer) / 2, (outer - inner) / 2, 12, 32); g.rotateX(Math.PI / 2); return g; } // Godot's torus rings the Y axis
      default: return null;
    }
  };

  // Material from the node's surface override, or the mesh resource's own
  // material — only StandardMaterial3D's basics (albedo/metallic/roughness).
  const materialForMesh = (node, meshSub) => {
    const raw = getProp(node, 'surface_material_override/0') ?? getProp(node, 'material_override') ?? (meshSub && getProp(meshSub, 'material'));
    const ref = raw === undefined ? null : parseRef(raw);
    const opts = { color: 0xcccccc, metalness: 0.1, roughness: 0.8 };
    const mat = ref && ref.kind === 'sub' ? subResource(ref.id) : null;
    if (mat) {
      const c = parseNums(getProp(mat, 'albedo_color') ?? '');
      if (c.length >= 3) opts.color = new THREE.Color(c[0], c[1], c[2]);
      opts.metalness = propNum(mat, 'metallic', opts.metalness);
      opts.roughness = propNum(mat, 'roughness', opts.roughness);
    }
    return new THREE.MeshStandardMaterial(opts);
  };

  const lightColor = (node) => {
    const c = parseNums(getProp(node, 'light_color') ?? '');
    return c.length >= 3 ? new THREE.Color(c[0], c[1], c[2]) : new THREE.Color(0xffffff);
  };

  // Small always-pickable proxy meshes for nodes that render nothing on their
  // own (lights, cameras, instanced scenes, unloadable meshes).
  const markerSphere = (color) => new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 12, 8),
    new THREE.MeshBasicMaterial({ color }),
  );
  const placeholderBox = (color) => new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.4, 0.4),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.35 }),
  );
  const cameraCone = () => {
    const g = new THREE.ConeGeometry(0.18, 0.36, 12);
    g.rotateX(-Math.PI / 2); // apex toward the node's -Z, Godot's view direction
    return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x9d7cd8, transparent: true, opacity: 0.6 }));
  };
  const emptyCross = () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.25, 0, 0, 0.25, 0, 0, 0, -0.25, 0, 0, 0.25, 0, 0, 0, -0.25, 0, 0, 0.25,
    ], 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x888888, depthTest: false, transparent: true }));
  };

  const visualFor = (node, type, instance) => {
    if (instance !== undefined) return placeholderBox(0x4a9eff);
    if (type === 'MeshInstance3D') {
      const ref = parseRef(getProp(node, 'mesh') ?? '');
      const meshSub = ref && ref.kind === 'sub' ? subResource(ref.id) : null;
      const geometry = meshSub && geometryForMesh(meshSub);
      if (geometry) return new THREE.Mesh(geometry, materialForMesh(node, meshSub));
      return placeholderBox(0x999999); // ArrayMesh/.res/ext meshes can't be decoded here
    }
    if (type === 'DirectionalLight3D' || type === 'OmniLight3D' || type === 'SpotLight3D') {
      const group = new THREE.Group();
      const color = lightColor(node);
      const energy = propNum(node, 'light_energy', 1);
      let light;
      if (type === 'OmniLight3D') light = new THREE.PointLight(color, energy, propNum(node, 'omni_range', 5));
      else if (type === 'SpotLight3D') light = new THREE.SpotLight(color, energy, propNum(node, 'spot_range', 5), THREE.MathUtils.degToRad(propNum(node, 'spot_angle', 45)));
      else light = new THREE.DirectionalLight(color, energy);
      group.add(light);
      if (light.target) { light.target.position.set(0, 0, -1); group.add(light.target); } // Godot lights point along local -Z
      group.add(markerSphere(color.getHex() === 0xffffff ? 0xffe28a : color));
      return group;
    }
    if (type === 'Camera3D') return cameraCone();
    return null;
  };

  // A node counts as transformable when Godot would let it carry a 3D
  // transform: any *3D type, an instanced scene, or a typeless override node
  // that already stores transform data.
  const isSpatial = (node, type, instance) => {
    if (type !== undefined) return /3D$/.test(type);
    if (instance !== undefined) return true;
    return ['transform', 'position', 'rotation', 'quaternion', 'scale'].some((k) => getProp(node, k) !== undefined);
  };

  // Visual children are implementation detail — tag them with the flag the
  // shared outliner/marker helpers already skip, so the tree shows only nodes.
  const markVisual = (o) => { o.traverse((c) => { c.userData.isEmptyMarker = true; }); return o; };

  const createNodeObject = (node) => {
    const type = attrStr(node, 'type');
    const instance = getAttr(node, 'instance');
    const obj = new THREE.Group();
    obj.name = attrStr(node, 'name') || '';
    obj.userData.nodePath = nodePathOf(node);
    obj.userData.transformable = isSpatial(node, type, instance);
    if (getProp(node, 'visible') === 'false') obj.visible = false;
    applyNodeTransform(obj, transformOfNode(node));
    const visual = visualFor(node, type, instance);
    if (visual) obj.add(markVisual(visual));
    return obj;
  };

  // Nodes are serialized depth-first with the root first, so each node's
  // parent path is already built when it comes up.
  const byPath = new Map();
  let rootObj = null;
  for (const node of nodes) {
    const path = nodePathOf(node);
    const obj = createNodeObject(node);
    byPath.set(path, obj);
    if (!rootObj) { rootObj = obj; continue; }
    (byPath.get(attrStr(node, 'parent')) || rootObj).add(obj);
  }

  // A framing pivot absorbs frameObject's recentring offset so the root node
  // keeps its own document transform — only user edits change node transforms.
  const pivot = new THREE.Group();
  pivot.add(rootObj);
  scene.add(pivot);
  // Fallback framing for a scene with no visible geometry (all empties).
  camera.position.set(6, 4, 8);
  controls.target.set(0, 0, 0);
  frameObject(pivot, camera, controls, viewer.grid);
  const markers = addEmptyMarkers(rootObj);

  // --- transform gizmo ---
  const gizmo = new TransformControls(camera, renderer.domElement);
  gizmo.setSpace('local');
  scene.add(gizmo.getHelper());
  gizmo.addEventListener('dragging-changed', (e) => { controls.enabled = !e.value; });

  // One undo entry per gizmo gesture; releasing also writes the node's new
  // local transform into the document.
  const snapXform = (o) => ({ position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() });
  const applyXform = (o, s) => { o.position.copy(s.position); o.quaternion.copy(s.quaternion); o.scale.copy(s.scale); };
  const sameXform = (a, b) => a.position.equals(b.position) && a.quaternion.equals(b.quaternion) && a.scale.equals(b.scale);
  let dragObj = null, dragBefore = null;
  gizmo.addEventListener('mouseDown', () => { dragObj = gizmo.object; dragBefore = dragObj && snapXform(dragObj); });
  gizmo.addEventListener('mouseUp', () => {
    if (!dragObj || !dragBefore) return;
    const o = dragObj, before = dragBefore, after = snapXform(o);
    dragObj = null; dragBefore = null;
    if (sameXform(before, after)) return;
    const beforeText = serializeTscn(doc);
    setNodeTransform(doc, o.userData.nodePath, transformNums(o));
    pushCommand({
      before: beforeText, after: serializeTscn(doc),
      undoScene: () => applyXform(o, before),
      redoScene: () => applyXform(o, after),
    });
  });

  const setMode = (mode) => {
    gizmo.setMode(mode);
    for (const m in modeButtons) modeButtons[m].classList.toggle('on', m === mode);
  };

  // --- edit dock ---
  const dock = document.createElement('div');
  dock.className = 'model-edit-panel';
  const dockHead = document.createElement('button');
  dockHead.className = 'model-tree-head';
  dockHead.title = 'Toggle editor panel';
  dockHead.innerHTML = '<span class="model-tree-caret">▾</span><span class="model-tree-title">Scene</span>';
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

  // Add-child section: new node types Godot users reach for first. The new
  // node lands as the last child of the selection (or the root).
  const ADDABLE = [
    { label: 'Box', type: 'MeshInstance3D', mesh: 'BoxMesh', name: 'Box' },
    { label: 'Sphere', type: 'MeshInstance3D', mesh: 'SphereMesh', name: 'Sphere' },
    { label: 'Cylinder', type: 'MeshInstance3D', mesh: 'CylinderMesh', name: 'Cylinder' },
    { label: 'Capsule', type: 'MeshInstance3D', mesh: 'CapsuleMesh', name: 'Capsule' },
    { label: 'Plane', type: 'MeshInstance3D', mesh: 'PlaneMesh', name: 'Plane' },
    { label: 'Node3D (empty)', type: 'Node3D', name: 'Node3D' },
    { label: 'Directional light', type: 'DirectionalLight3D', name: 'DirectionalLight3D' },
    { label: 'Omni light', type: 'OmniLight3D', name: 'OmniLight3D' },
    { label: 'Spot light', type: 'SpotLight3D', name: 'SpotLight3D' },
    { label: 'Camera', type: 'Camera3D', name: 'Camera3D' },
  ];
  const addBody = section('Add child');
  const addSelect = document.createElement('select');
  addSelect.className = 'model-edit-select';
  for (const s of ADDABLE) {
    const opt = document.createElement('option');
    opt.textContent = s.label;
    addSelect.appendChild(opt);
  }
  const addBtn = assetBtn('Add', () => addSelected());
  addBtn.title = 'Add as a child of the selected node';
  addBody.append(addSelect, addBtn);

  const nodeBody = section('Node');
  const delBtn = assetBtn('Delete', () => deleteSelected());
  delBtn.title = 'Delete the selected node and its children (Del)';
  const nodeRow = document.createElement('div');
  nodeRow.className = 'model-edit-row';
  nodeRow.append(delBtn);
  nodeBody.appendChild(nodeRow);

  // --- selection / structural edits ---
  let outliner = null;
  const updateSelection = (obj) => {
    if (obj && obj.userData.transformable) gizmo.attach(obj); else gizmo.detach();
    delBtn.disabled = !obj || obj === rootObj;
  };
  const reselect = (obj) => {
    outliner.rebuild();
    if (obj) outliner.selectObject(obj); else outliner.deselect();
    updateSelection(outliner.getSelected());
  };

  const addSelected = () => {
    const spec = ADDABLE[addSelect.selectedIndex];
    const parentObj = outliner.getSelected() || rootObj;
    const parentPath = parentObj.userData.nodePath;
    const beforeText = serializeTscn(doc);
    const props = [];
    if (spec.mesh) props.push({ key: 'mesh', value: `SubResource("${addSubResource(doc, spec.mesh)}")` });
    const name = uniqueChildName(doc, parentPath, spec.name);
    const node = addNode(doc, { parentPath, type: spec.type, name, props });
    const obj = createNodeObject(node);
    if (spec.type === 'Node3D') obj.add(markVisual(emptyCross())); // load-time crosses come from addEmptyMarkers
    parentObj.add(obj);
    pushCommand({
      before: beforeText, after: serializeTscn(doc),
      undoScene: () => { parentObj.remove(obj); reselect(null); },
      redoScene: () => { parentObj.add(obj); reselect(obj); },
    });
    reselect(obj);
  };

  const deleteSelected = () => {
    const obj = outliner.getSelected();
    if (!obj || obj === rootObj || !obj.parent) return;
    const beforeText = serializeTscn(doc);
    removeNodeTree(doc, obj.userData.nodePath);
    const parent = obj.parent;
    parent.remove(obj);
    pushCommand({
      before: beforeText, after: serializeTscn(doc),
      undoScene: () => { parent.add(obj); reselect(obj); },
      redoScene: () => { parent.remove(obj); reselect(null); },
    });
    reselect(null);
  };

  // --- click a node in the viewport to select it ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const nodeOf = (o) => { for (let n = o; n && n !== scene; n = n.parent) if (n.userData.nodePath) return n; return null; };
  const isPickable = (o) => {
    for (let n = o; n; n = n.parent) { if (!n.visible) return false; if (n === rootObj) break; }
    return true;
  };
  const pickAt = (clientX, clientY) => {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    for (const hit of raycaster.intersectObject(rootObj, true)) {
      const node = nodeOf(hit.object);
      if (!node || !isPickable(hit.object)) continue;
      outliner.selectObject(node);
      return;
    }
    outliner.deselect();
  };
  let downX = 0, downY = 0, downOnGizmo = false;
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    downX = e.clientX; downY = e.clientY;
    downOnGizmo = !!gizmo.axis;
  };
  const onPointerUp = (e) => {
    if (e.button !== 0 || downOnGizmo || gizmo.dragging) return;
    const dx = e.clientX - downX, dy = e.clientY - downY;
    if (dx * dx + dy * dy > 25) return; // an orbit drag, not a pick
    pickAt(e.clientX, e.clientY);
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  outliner = buildHierarchy(rootObj, viewer.wrap, controls, scene, markers, { onSelect: updateSelection });
  updateSelection(null);
  setMode('translate');
  viewer.wrap.appendChild(dock);
  viewer.resize();
  viewer.start();

  // --- save ---
  async function save() {
    if (!dirty || saving) return;
    saving = true; refreshSave(); setStatus('Saving…');
    const r = await window.api.writeText(file, serializeTscn(doc));
    saving = false;
    if (r.ok) { dirty = false; setStatus('Saved'); refreshGit(); }
    else setStatus(r.error || 'Save failed');
    refreshSave();
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
    document.removeEventListener('keydown', onKey, true);
    renderer.domElement.removeEventListener('pointerdown', onPointerDown);
    renderer.domElement.removeEventListener('pointerup', onPointerUp);
    gizmo.detach();
    scene.remove(gizmo.getHelper());
    gizmo.dispose();
    viewer.dispose();
  });
}
