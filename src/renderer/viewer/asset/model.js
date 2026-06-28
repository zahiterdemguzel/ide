import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { USDZLoader } from 'three/addons/loaders/USDZLoader.js';
import { assetBtn } from './ui.js';

// 3D model view: a three.js scene with orbit/zoom/pan controls. Each supported
// format has its own loader; they all reduce to a single Object3D we frame to
// the viewport. The whole module is dynamically imported by the asset
// coordinator (see asset/index.js) so three.js never costs app startup.
//
// `base64` is the file's bytes (from read-asset); `ext` selects the loader;
// `body`/`tools` are the asset view's containers; `registerCleanup` lets the
// coordinator stop our render loop and free the GPU context when the view closes.
export function renderModel(base64, ext, body, tools, registerCleanup) {
  const wrap = document.createElement('div');
  wrap.className = 'model-viewer';
  body.appendChild(wrap);

  const buffer = base64ToArrayBuffer(base64);

  const scene = new THREE.Scene();
  const css = getComputedStyle(document.documentElement);
  scene.background = new THREE.Color(css.getPropertyValue('--bg-2').trim() || '#1e1e1e');

  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10000);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
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

  let framed = null; // remembered camera framing, for the Reset view button
  const onLoaded = (object) => {
    scene.add(object);
    framed = frameObject(object, camera, controls, grid);
    buildHierarchy(object, wrap, controls);
    resize();
    tick();
  };
  const onError = (e) => {
    wrap.classList.add('model-err');
    wrap.textContent = 'Could not load model: ' + (e && e.message ? e.message : e);
  };

  // Via a microtask so a synchronous throw from a sync loader (FBX/OBJ/STL/PLY
  // parse) surfaces as a rejection through onError, not an uncaught exception.
  Promise.resolve().then(() => loadModel(ext, buffer)).then(onLoaded).catch(onError);

  tools.append(assetBtn('Reset view', () => { if (framed) framed(); }));

  registerCleanup?.(() => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    disposeScene(scene);
    renderer.dispose();
    renderer.forceContextLoss();
  });
}

// Dispatch to the right loader and normalise every result to a single Object3D.
// The async loaders (glTF/USDZ) take a callback; the sync ones return directly.
function loadModel(ext, buffer) {
  if (ext === 'glb' || ext === 'gltf') {
    // .glb is binary (ArrayBuffer); .gltf is JSON text. Both parse from a single
    // self-contained file — a .gltf referencing external .bin/textures won't
    // resolve them (we have only the one file's bytes), which is an accepted limit.
    const data = ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
    return parseAsync((onLoad, onError) => new GLTFLoader().parse(data, '', onLoad, onError))
      .then((gltf) => gltf.scene);
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

// Centre the model at the origin, drop the grid to its base, and pull the camera
// back so the whole bounding sphere fits the frame. Returns a function that
// re-applies this framing (the Reset view button).
function frameObject(object, camera, controls, grid) {
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

// Overlay outliner pinned to the viewport's top-left: a collapsible tree of the
// model's scene graph, mirroring the Object3D hierarchy. Clicking a node parks
// the orbit pivot on it; the eye toggles that branch's visibility. Lights and
// cameras the loader injects are skipped — only the model's own nodes show.
function buildHierarchy(root, wrap, controls) {
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

  let selectedRow = null;
  const select = (row, obj) => {
    if (selectedRow) selectedRow.classList.remove('sel');
    selectedRow = row;
    row.classList.add('sel');
    const box = new THREE.Box3().setFromObject(obj);
    if (!box.isEmpty()) {
      controls.target.copy(box.getCenter(new THREE.Vector3()));
      controls.update();
    }
  };

  const makeNode = (obj, depth) => {
    const node = document.createElement('div');
    node.className = 'model-node';

    const row = document.createElement('div');
    row.className = 'model-row';
    row.style.paddingLeft = (depth * 14 + 8) + 'px';

    const kids = obj.children.filter((c) => !c.isLight && !c.isCamera);

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

    const eye = document.createElement('button');
    eye.className = 'model-row-eye';
    eye.title = 'Toggle visibility';
    eye.textContent = '◉';
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = !obj.visible;
      row.classList.toggle('hidden', !obj.visible);
      eye.textContent = obj.visible ? '◉' : '○';
    });
    row.appendChild(eye);

    row.addEventListener('click', () => select(row, obj));
    node.appendChild(row);

    if (kids.length) {
      const childWrap = document.createElement('div');
      childWrap.className = 'model-children';
      for (const kid of kids) childWrap.appendChild(makeNode(kid, depth + 1));
      node.appendChild(childWrap);
    }
    return node;
  };

  list.appendChild(makeNode(root, 0));
  wrap.appendChild(panel);
}

// A short type tag for an outliner row, so a Group reads differently from a Mesh
// at a glance without bundling an icon set.
function nodeGlyph(obj) {
  if (obj.isMesh) return 'M';
  if (obj.isGroup || obj.type === 'Object3D') return 'G';
  if (obj.isBone) return 'B';
  return '•';
}

function disposeScene(scene) {
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

function base64ToArrayBuffer(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
