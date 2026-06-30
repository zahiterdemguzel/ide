import { zoomToward } from '../../shared/svg-ops.js';

// Lazy paper.js loader + a thin PaperScope/canvas core for the vector editor —
// the model-scene.js analogue. paper ships a UMD/global build (not clean ESM), so
// it can't live in index.html's importmap like three. We inject its <script> on
// first use and read window.paper. This is allowed by the page CSP
// (`script-src 'self' 'nonce-…'`): the nonce is only required for *inline* scripts;
// an external same-origin script (node_modules is 'self') needs none. We load
// `paper-core` (not `-full`) so the Acorn/PaperScript `eval` path is never bundled —
// we drive the library through its plain API, never PaperScript. The editor module
// is itself dynamically imported, so none of this costs app startup.

let paperPromise = null;

export function loadPaper() {
  if (paperPromise) return paperPromise;
  paperPromise = new Promise((resolve, reject) => {
    if (window.paper) { resolve(window.paper); return; }
    const s = document.createElement('script');
    s.src = 'node_modules/paper/dist/paper-core.min.js';
    s.onload = () => (window.paper ? resolve(window.paper) : reject(new Error('paper.js loaded but window.paper is missing')));
    s.onerror = () => reject(new Error('Failed to load paper.js'));
    document.head.appendChild(s);
  });
  return paperPromise;
}

// An isolated PaperScope on a fresh canvas inside `body`. Each editor instance gets
// its own scope so two opens never share a project; a ResizeObserver keeps the view
// sized to the body. Returns the scope/project/view plus resize/dispose, mirroring
// model-scene's createViewer.
export function createCanvas(paper, body) {
  const wrap = document.createElement('div');
  wrap.className = 'vector-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'vector-canvas';
  wrap.appendChild(canvas);
  body.appendChild(wrap);

  const scope = new paper.PaperScope();
  scope.setup(canvas);

  const resize = () => {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    scope.view.viewSize = new scope.Size(w, h);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  const dispose = () => {
    ro.disconnect();
    try { scope.project.clear(); scope.view.remove(); } catch { /* already torn down */ }
    wrap.remove();
  };

  return { scope, project: scope.project, view: scope.view, canvas, wrap, resize, dispose };
}

// Parse an SVG string into the project. expandShapes:false keeps <rect>/<circle>/
// <ellipse> as Shape items so they round-trip as those elements (and corner-radius
// editing has a real rect to mutate). Returns the imported root item.
export function importSvg(scope, text) {
  return scope.project.importSVG(text, { expandShapes: false, insert: true, applyMatrix: false });
}

// Serialize the project back to an SVG string. The caller re-stamps the document's
// original width/height/viewBox (paper sizes to content bounds) via svg-ops.
export function exportSvg(scope) {
  return scope.project.exportSVG({ asString: true, bounds: 'content', matchShapes: true });
}

// Zoom about a project-space anchor so that point stays under the cursor. factor>1
// zooms in; the result is clamped to a sane range. Pure zoom math lives in svg-ops.
export function zoomAt(scope, factor, projPoint) {
  const view = scope.view;
  const oldZoom = view.zoom;
  const newZoom = Math.max(0.02, Math.min(64, oldZoom * factor));
  if (newZoom === oldZoom) return;
  const c = zoomToward({ x: view.center.x, y: view.center.y }, oldZoom, newZoom, { x: projPoint.x, y: projPoint.y });
  view.zoom = newZoom;
  view.center = new scope.Point(c.x, c.y);
  view.update();
}

// Frame an item (or the whole artwork) to fit the viewport with a little padding.
export function fitView(scope, item) {
  const view = scope.view;
  const b = item && item.bounds && item.bounds.width ? item.bounds : null;
  if (!b) { view.zoom = 1; view.center = new scope.Point(0, 0); view.update(); return; }
  const pad = 1.15;
  const z = Math.min(view.viewSize.width / (b.width * pad), view.viewSize.height / (b.height * pad));
  view.zoom = Math.max(0.02, Math.min(64, z || 1));
  view.center = b.center;
  view.update();
}
