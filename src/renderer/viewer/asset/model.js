import { base64ToArrayBuffer } from '../../shared/base64.js';
import {
  createViewer, loadModel, frameObject,
  applyColliderWireframe, addEmptyMarkers, buildHierarchy,
} from './model-scene.js';
import { assetBtn } from './ui.js';

// Read-only 3D model view: a three.js scene (built by the shared core in
// model-scene.js) with orbit/zoom/pan controls and the scene-graph outliner. The
// editor (model-editor.js) builds on the same core; this entry just adds the
// "Reset view" button and, when `onEdit` is supplied (glTF/GLB only), an "Edit"
// button that hands off to that editor.
//
// `base64` is the file's bytes (from read-asset); `ext` selects the loader;
// `body`/`tools` are the asset view's containers; `registerCleanup` lets the
// coordinator stop our render loop and free the GPU context when the view closes.
export function renderModel(base64, ext, body, tools, registerCleanup, onEdit) {
  const viewer = createViewer(body);
  const buffer = base64ToArrayBuffer(base64);

  let framed = null; // remembered camera framing, for the Reset view button
  const onLoaded = (object) => {
    viewer.scene.add(object);
    applyColliderWireframe(object);
    framed = frameObject(object, viewer.camera, viewer.controls, viewer.grid);
    const markers = addEmptyMarkers(object);
    buildHierarchy(object, viewer.wrap, viewer.controls, viewer.scene, markers);
    viewer.resize();
    viewer.start();
  };
  const onError = (e) => {
    viewer.wrap.classList.add('model-err');
    viewer.wrap.textContent = 'Could not load model: ' + (e && e.message ? e.message : e);
  };

  // Via a microtask so a synchronous throw from a sync loader (FBX/OBJ/STL/PLY
  // parse) surfaces as a rejection through onError, not an uncaught exception.
  Promise.resolve().then(() => loadModel(ext, buffer)).then(onLoaded).catch(onError);

  tools.append(assetBtn('Reset view', () => { if (framed) framed(); }));
  if (onEdit) {
    const edit = assetBtn('Edit', onEdit);
    edit.title = 'Edit this model — move/scale parts, adjust textures, edit materials';
    tools.append(edit);
  }

  registerCleanup?.(viewer.dispose);
}
