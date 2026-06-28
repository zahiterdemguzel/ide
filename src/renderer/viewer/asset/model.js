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
