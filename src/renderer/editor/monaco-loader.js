// Loads Monaco (VS Code's editor component) on first use. The app has no
// bundler, so we use Monaco's prebuilt AMD distribution: inject its loader
// script, point it at node_modules, and require the editor bundle. Language
// grammars and the TS/JSON/CSS/HTML workers then load lazily as files need them.
//
// The AMD loader installs a global `define` with `define.amd` set. UMD libraries
// the app injects later with a plain <script> (paper.js for the vector editor)
// would see `define.amd` and register as anonymous AMD modules instead of
// setting their global — so once Monaco is up we hide the `amd` marker. Monaco's
// own lazy chunks call `define(...)` directly and don't look at the marker.

const VS_PATH = 'node_modules/monaco-editor/min/vs';

let loading = null;

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function injectStylesheet(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  // Before the app's own sheets so our editor.css overrides win on equal specificity.
  const first = document.querySelector('link[rel="stylesheet"]');
  document.head.insertBefore(link, first);
}

export function loadMonaco() {
  if (loading) return loading;
  loading = (async () => {
    injectStylesheet(`${VS_PATH}/editor/editor.main.css`);
    await injectScript(`${VS_PATH}/loader.js`);
    const amdRequire = window.require;
    amdRequire.config({ paths: { vs: VS_PATH } });
    const monaco = await new Promise((resolve, reject) => {
      amdRequire(['vs/editor/editor.main'], (mod) => resolve(window.monaco || mod), reject);
    });
    if (window.define && window.define.amd) delete window.define.amd;
    return monaco;
  })();
  return loading;
}

// Warm the editor in the background once the app is idle, so the first file
// open doesn't pay the bundle parse.
export function preloadMonacoWhenIdle() {
  const start = () => { loadMonaco().catch((e) => console.error('[monaco preload]', e)); };
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 8000 });
  else setTimeout(start, 3000);
}
