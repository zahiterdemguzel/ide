'use strict';

const path = require('path');

// electron-builder always drops each dependency's top-level `examples/` directory,
// and no `files` pattern can bring it back: NodeModuleCopyHelper checks the name
// before it ever consults the filter. three.js ships its addons (OrbitControls,
// GLTFLoader, ...) under examples/jsm, which is what the renderer's import map
// points `three/addons/` at — so without this hook every three.js import 404s in a
// packaged build and the 3D model views die with "Failed to fetch dynamically
// imported module". Returning truthy here force-includes the file.
// Matches the `examples` directory itself as well as everything under it — the
// directory entry has to be force-included too, or the walker never descends.
const THREE_ADDONS = path.join('node_modules', 'three', 'examples');

exports.onNodeModuleFile = (file) => {
  const norm = path.normalize(file);
  return norm.endsWith(THREE_ADDONS) || norm.includes(THREE_ADDONS + path.sep);
};
