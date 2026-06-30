import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';

// Shared three.js core for the 3D model views. The read-only viewer (model.js)
// and the editor (model-editor.js) both build on the same scene setup, loaders,
// framing, outliner, and disposal — only their chrome (Reset view vs. the edit
// dock + gizmo + save) differs. Keeping the common parts here avoids two copies
// drifting apart. This module is only ever reached through model.js/model-editor.js,
// which are themselves dynamically imported, so three.js still costs no startup.

// Build the scene/camera/renderer/lights/grid/orbit controls and the render loop,
// appending the canvas to `body`. Returns the pieces the entry points need plus a
// `start()` (begin the rAF loop), `resize()`, and a `dispose()` teardown.
export function createViewer(body) {
  const wrap = document.createElement('div');
  wrap.className = 'model-viewer';
  body.appendChild(wrap);

  const scene = new THREE.Scene();
  const css = getComputedStyle(document.documentElement);
  scene.background = new THREE.Color(css.getPropertyValue('--bg-2').trim() || '#1e1e1e');

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);

  // powerPreference asks a multi-GPU machine to drive the 3D viewer with the
  // discrete GPU rather than integrated graphics.
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  wrap.appendChild(renderer.domElement);

  // Even lighting so an unlit/material-less mesh (a bare STL/OBJ) is still
  // readable from any angle, plus a key light for form.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(1, 1.5, 1);
  scene.add(key);

  const grid = new THREE.GridHelper(10, 10, 0x555555, 0x333333);
  scene.add(grid);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  let raf = 0;
  const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); };

  const resize = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
  };

  return { wrap, scene, camera, renderer, controls, grid, resize, start: tick, dispose };
}

// Dispatch to the right loader and normalise every result to a single Object3D.
// The async loaders (glTF/USDZ) take a callback; the sync ones return directly.
export function loadModel(ext, buffer) {
  if (ext === 'glb' || ext === 'gltf') {
    // .glb is binary (ArrayBuffer); .gltf is JSON text. Both parse from a single
    // self-contained file — a .gltf referencing external .bin/textures won't
    // resolve them (we have only the one file's bytes), which is an accepted limit.
    const data = ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
    return parseAsync((onLoad, onError) => new GLTFLoader().parse(data, '', onLoad, onError))
      .then((gltf) => { tagPrimitiveGroups(gltf); return gltf.scene; });
  }
  if (ext === 'usdz') {
    return parseAsync((onLoad, onError) => new USDZLoader().parse(buffer, '', onLoad, onError));
  }
  if (ext === 'fbx') return Promise.resolve(new FBXLoader().parse(buffer, ''));
  if (ext === 'obj') return Promise.resolve(new OBJLoader().parse(new TextDecoder().decode(buffer)));
  if (ext === 'stl') return Promise.resolve(meshFromGeometry(new STLLoader().parse(buffer)));
  if (ext === 'ply') return Promise.resolve(meshFromGeometry(new PLYLoader().parse(buffer)));
  return Promise.reject(new Error('Unsupported format: ' + ext));
}

// Wrap a callback-style loader.parse() in a promise.
function parseAsync(run) {
  return new Promise((resolve, reject) => {
    try { run(resolve, reject); } catch (e) { reject(e); }
  });
}

// STL/PLY loaders return a bare BufferGeometry; give it normals (STL meshes
// often lack them) and a default material, honouring per-vertex colours if the
// geometry carries them (common in PLY scans).
function meshFromGeometry(geometry) {
  // No normals (common in STL) → flat shading reads cleaner on faceted CAD parts
  // than the smoothed normals computeVertexNormals would synthesise.
  const flatShading = !geometry.attributes.normal;
  if (flatShading) geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({
    color: 0xcccccc, metalness: 0.1, roughness: 0.8,
    vertexColors: !!geometry.attributes.color,
    flatShading,
  });
  return new THREE.Mesh(geometry, material);
}

// glTF represents a single mesh that uses several materials as a Group of
// per-material primitive meshes (one draw call each). We don't want the outliner
// to list those primitives as separate objects, nor the gizmo/click-pick to grab
// one material island — they're one logical mesh. Tag the wrapping group and its
// primitive children (via the loader's own associations, the reliable signal) so
// the outliner folds them into one row and selection rolls a primitive up to its
// group. Kept in WeakSets, not userData, so the tags never leak into a saved file
// (GLTFExporter serialises userData into glTF `extras`).
const primitiveGroups = new WeakSet();
const meshPrimitives = new WeakSet();
export const isPrimitiveGroup = (obj) => primitiveGroups.has(obj);
export const isMeshPrimitive = (obj) => meshPrimitives.has(obj);

function tagPrimitiveGroups(gltf) {
  const assoc = gltf.parser && gltf.parser.associations;
  if (!assoc) return;
  for (const [obj, a] of assoc) {
    // A multi-primitive mesh group is associated with a glTF mesh but not with a
    // single primitive (each per-material child mesh carries its `primitives` index).
    if (!a || a.meshes === undefined || a.primitives !== undefined) continue;
    let any = false;
    for (const child of obj.children) if (child.isMesh) { meshPrimitives.add(child); any = true; }
    if (any) primitiveGroups.add(obj);
  }
}

// dst is src.clone(true): same structure, so a lock-step traversal carries the
// primitive-group tags onto the clone (clone() can't copy WeakSet membership).
export function copyPrimitiveTags(src, dst) {
  const from = [], to = [];
  src.traverse((o) => from.push(o));
  dst.traverse((o) => to.push(o));
  for (let i = 0; i < from.length && i < to.length; i++) {
    if (primitiveGroups.has(from[i])) primitiveGroups.add(to[i]);
    if (meshPrimitives.has(from[i])) meshPrimitives.add(to[i]);
  }
}

// Centre the model at the origin, drop the grid to its base, and pull the camera
// back so the whole bounding sphere fits the frame. Returns a function that
// re-applies this framing (the Reset view button).
export function frameObject(object, camera, controls, grid) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return () => {};
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  // Recentre the model on the origin so orbit pivots around it.
  object.position.sub(center);
  grid.position.y = -size.y / 2;
  const radius = Math.max(size.x, size.y, size.z, 0.001);
  grid.scale.setScalar(Math.max(1, radius / 5));

  const dist = radius * 2.2;
  const apply = () => {
    camera.position.set(dist * 0.7, dist * 0.6, dist);
    camera.near = radius / 100;
    camera.far = radius * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
  };
  apply();
  return apply;
}

// A node is treated as a collider when "collider" appears in its own name or any
// ancestor's — colliders are physics volumes, so they read better as a wireframe
// cage than as solid textured geometry.
const COLLIDER_RE = /collider/i;
export function isCollider(obj) {
  for (let n = obj; n; n = n.parent) if (COLLIDER_RE.test(n.name || '')) return true;
  return false;
}

// Force every collider mesh to wireframe on load so its volume is visible without
// occluding the real geometry behind it.
export function applyColliderWireframe(root) {
  root.traverse((o) => { if (o.isMesh && isCollider(o)) setMeshWireframe(o, true); });
}

// "Empty" nodes (transforms with no mesh anywhere beneath them — locators, spawn
// points, bone roots) render nothing on their own, so drop a small cross marker
// at each so it shows in the viewport and can be picked. Returns object→marker so
// selection can recolour the chosen empty. Markers are added as children to
// inherit each node's transform, and tagged so the outliner skips them as rows.
export function addEmptyMarkers(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.isEmpty() ? 1 : box.getSize(new THREE.Vector3()).length() * 0.02;
  const empties = [];
  root.traverse((o) => {
    if (o.isMesh || o.isLight || o.isCamera) return;
    if (!hasMeshDescendant(o)) empties.push(o);
  });
  const markers = new Map();
  for (const o of empties) {
    const marker = makeEmptyMarker(size);
    o.add(marker);
    markers.set(o, marker);
  }
  return markers;
}

function hasMeshDescendant(obj) {
  let found = false;
  obj.traverse((o) => { if (o !== obj && o.isMesh) found = true; });
  return found;
}

// A 3-axis cross drawn over everything (depthTest off) so an empty stays visible
// inside other geometry. Black by default; selection flips the colour to white.
function makeEmptyMarker(size) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -size, 0, 0, size, 0, 0,
    0, -size, 0, 0, size, 0,
    0, 0, -size, 0, 0, size,
  ], 3));
  const material = new THREE.LineBasicMaterial({ color: 0x000000, depthTest: false, transparent: true });
  const marker = new THREE.LineSegments(geometry, material);
  marker.renderOrder = 998;
  marker.userData.isEmptyMarker = true;
  return marker;
}

// Wireframe lives on the material, so toggling a node walks its subtree's meshes.
export function setMeshWireframe(obj, on) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m) m.wireframe = on;
    }
  });
}

// Overlay outliner pinned to the viewport's top-left: a collapsible tree of the
// model's scene graph, mirroring the Object3D hierarchy. Hovering or selecting a
// node draws its bounding box in the scene so you can see which part it is;
// clicking parks the orbit pivot on it; the eye toggles that branch's
// visibility and the wireframe button toggles its meshes' wireframe rendering.
// Lights and cameras the loader injects are skipped — only the model's nodes show.
//
// `opts` adapts the same tree to the editor: `onSelect(obj)` fires on selection
// (the editor attaches the transform gizmo); `editable` makes rows drag-and-drop
// reparentable, reporting valid drops via `onReparent(child, newParent)`. Returns
// a controller — `{ getSelected, selectObject, rebuild }` — so the editor can
// react to row clicks and redraw the tree after structural edits.
export function buildHierarchy(root, wrap, controls, scene, markers, opts = {}) {
  const { onSelect, editable = false, onReparent } = opts;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-hi').trim();
  const boxColor = new THREE.Color(accent || '#3794ff');

  // A single live BoxHelper marks the hovered/selected node; depthTest off so it
  // stays visible even when the node is inside other geometry.
  let activeBox = null;
  let selectedObj = null;
  const clearBox = () => {
    if (!activeBox) return;
    scene.remove(activeBox);
    activeBox.geometry.dispose();
    activeBox.material.dispose();
    activeBox = null;
  };
  const showBox = (obj) => {
    clearBox();
    if (new THREE.Box3().setFromObject(obj).isEmpty()) return;
    const helper = new THREE.BoxHelper(obj, boxColor);
    helper.material.depthTest = false;
    helper.material.transparent = true;
    helper.renderOrder = 999;
    scene.add(helper);
    activeBox = helper;
  };

  // An empty has no box to outline, so its selection cue is its marker turning
  // white (black otherwise). Only one empty is lit at a time.
  let litMarker = null;
  const highlightMarker = (obj) => {
    if (litMarker) litMarker.material.color.set(0x000000);
    litMarker = markers.get(obj) || null;
    if (litMarker) litMarker.material.color.set(0xffffff);
  };

  const panel = document.createElement('div');
  panel.className = 'model-tree';

  const head = document.createElement('button');
  head.className = 'model-tree-head';
  head.title = 'Toggle hierarchy';
  head.innerHTML = '<span class="model-tree-caret">▾</span>'
    + '<span class="model-tree-title">Hierarchy</span>';
  head.addEventListener('click', () => panel.classList.toggle('collapsed'));
  panel.appendChild(head);

  const list = document.createElement('div');
  list.className = 'model-tree-body';
  panel.appendChild(list);

  // Row bookkeeping, rebuilt on every (re)render so selectObject() can map a node
  // back to its row and rebuild() can re-highlight the surviving selection.
  let rowByObj = new Map();
  let selectedRow = null;

  const select = (row, obj) => {
    if (selectedRow) selectedRow.classList.remove('sel');
    selectedRow = row;
    selectedObj = obj;
    row.classList.add('sel');
    showBox(obj);
    highlightMarker(obj);
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty()) {
      controls.target.copy(box.getCenter(new THREE.Vector3()));
      controls.update();
    }
    onSelect?.(obj);
  };

  // Drag-and-drop reparenting (editor only). A drop is rejected when the target is
  // the dragged node itself or one of its descendants (which would make a cycle).
  let dragObj = null;
  const isAncestorOrSelf = (maybe, node) => {
    for (let n = node; n; n = n.parent) if (n === maybe) return true;
    return false;
  };
  const wireDrag = (row, obj) => {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      dragObj = obj;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', obj.uuid || '');
    });
    row.addEventListener('dragend', () => { dragObj = null; row.classList.remove('drop-target'); });
    row.addEventListener('dragover', (e) => {
      if (!dragObj || isAncestorOrSelf(dragObj, obj)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const child = dragObj;
      dragObj = null;
      if (child && !isAncestorOrSelf(child, obj)) onReparent?.(child, obj);
    });
  };

  const makeNode = (obj, depth) => {
    const node = document.createElement('div');
    node.className = 'model-node';

    const row = document.createElement('div');
    row.className = 'model-row';
    row.style.paddingLeft = (depth * 14 + 8) + 'px';
    rowByObj.set(obj, row);

    const kids = obj.children.filter((c) => !c.isLight && !c.isCamera && !c.userData.isEmptyMarker && !meshPrimitives.has(c));

    const caret = document.createElement('span');
    caret.className = 'model-row-caret';
    if (kids.length) {
      caret.textContent = '▾';
      caret.addEventListener('click', (e) => { e.stopPropagation(); node.classList.toggle('collapsed'); });
    }
    row.appendChild(caret);

    const icon = document.createElement('span');
    icon.className = 'model-row-icon';
    icon.textContent = nodeGlyph(obj);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'model-row-label';
    label.textContent = obj.name || obj.type;
    label.title = obj.name ? `${obj.name} (${obj.type})` : obj.type;
    row.appendChild(label);

    const wire = document.createElement('button');
    wire.className = 'model-row-wire';
    // Colliders load wireframed, so reflect that in the toggle's initial state.
    let wireOn = isCollider(obj);
    wire.title = wireOn ? 'Collider (wireframe)' : 'Toggle wireframe';
    wire.textContent = '◫';
    wire.classList.toggle('on', wireOn);
    wire.addEventListener('click', (e) => {
      e.stopPropagation();
      wireOn = !wireOn;
      setMeshWireframe(obj, wireOn);
      wire.classList.toggle('on', wireOn);
    });
    row.appendChild(wire);

    const eye = document.createElement('button');
    eye.className = 'model-row-eye';
    eye.title = 'Toggle visibility';
    eye.textContent = obj.visible ? '◉' : '○';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = !obj.visible;
      row.classList.toggle('hidden', !obj.visible);
      eye.textContent = obj.visible ? '◉' : '○';
    });
    row.appendChild(eye);

    // Hovering a row previews that node's box; leaving falls back to the
    // selected node's box (or none) so the highlight tracks the selection.
    row.addEventListener('mouseenter', () => showBox(obj));
    row.addEventListener('mouseleave', () => { if (selectedObj) showBox(selectedObj); else clearBox(); });
    row.addEventListener('click', () => select(row, obj));
    if (editable) wireDrag(row, obj);
    node.appendChild(row);

    if (kids.length) {
      const childWrap = document.createElement('div');
      childWrap.className = 'model-children';
      for (const kid of kids) childWrap.appendChild(makeNode(kid, depth + 1));
      node.appendChild(childWrap);
    }
    return node;
  };

  const render = () => {
    rowByObj = new Map();
    selectedRow = null;
    list.innerHTML = '';
    list.appendChild(makeNode(root, 0));
    // Re-highlight the selection if it survived a structural edit; otherwise drop it.
    if (selectedObj && rowByObj.has(selectedObj)) {
      const row = rowByObj.get(selectedObj);
      row.classList.add('sel');
      selectedRow = row;
    } else {
      selectedObj = null;
      clearBox();
      highlightMarker(null);
    }
  };

  render();
  wrap.appendChild(panel);

  return {
    getSelected: () => selectedObj,
    selectObject: (obj) => { const row = rowByObj.get(obj); if (row) select(row, obj); },
    deselect: () => {
      if (selectedRow) selectedRow.classList.remove('sel');
      selectedRow = null;
      selectedObj = null;
      clearBox();
      highlightMarker(null);
      onSelect?.(null);
    },
    rebuild: render,
  };
}

// A short type tag for an outliner row, so a Group reads differently from a Mesh
// at a glance without bundling an icon set.
function nodeGlyph(obj) {
  if (obj.isMesh || primitiveGroups.has(obj)) return 'M';
  if (obj.isGroup || obj.type === 'Object3D') return 'G';
  if (obj.isBone) return 'B';
  return '•';
}

export function disposeScene(scene) {
  scene.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mat = obj.material;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      for (const k in m) { const v = m[k]; if (v && v.isTexture) v.dispose(); }
      m.dispose();
    }
  });
}
