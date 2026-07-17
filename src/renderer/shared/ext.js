// File-extension helpers shared across the UI: which extensions are images/audio
// (route to the asset viewer) and per-extension filename colours for the tree.

export function extOf(file) { const m = /\.([^.]+)$/.exec(file); return m ? m[1].toLowerCase() : ''; }

// Images/audio/3D-models/vector open the asset viewer; everything else gets the
// text diff/viewer. SVG is NOT here — it routes through VECTOR_EXT to the vector
// editor (a raster <img> can't be edited as paths).
// .ico gets a dedicated multi-frame view inside the asset viewer (an icon file
// bundles several sizes; a plain <img> would show only one).
export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico']);
export const AUDIO_EXT = new Set(['wav', 'ogg', 'mp3']);
// Video formats routed to the video player. The first group is what Chromium
// decodes natively (the web formats plus H.264/AAC in MP4 and QuickTime); the
// rest are common container formats it usually cannot decode. They are listed
// anyway so the player can say so and offer "Open externally" — better than the
// text viewer dumping the bytes. `.ts` is deliberately absent: MPEG transport
// streams are far rarer than TypeScript files.
export const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'webm', 'ogv',
  'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', '3gp', 'm2ts',
]);
// 3D model formats the three.js viewer can render (one loader per extension).
export const MODEL_EXT = new Set(['glb', 'gltf', 'fbx', 'obj', 'usdz', 'stl', 'ply']);
// Subset of MODEL_EXT the 3D editor can write back: only the glTF family round-trips
// through three.js's GLTFExporter (embedded textures + node transforms). The other
// formats have no exporter, so they stay view-only.
export const EDITABLE_MODEL_EXT = new Set(['glb', 'gltf']);
// Vector formats the paper.js viewer/editor opens: SVG (full editor) and Adobe
// Illustrator (view-only — modern .ai is a PDF wrapper with no pure-JS write-back).
export const VECTOR_EXT = new Set(['svg', 'ai']);
// Subset of VECTOR_EXT the vector editor can write back: only SVG round-trips
// through paper.js's exportSVG. .ai stays a view-only preview.
export const EDITABLE_VECTOR_EXT = new Set(['svg']);
// PDF opens the pdf.js viewer with a page-level editor (rotate / delete /
// reorder pages via pdf-lib). Content-level editing (text/vector) is out of scope.
export const PDF_EXT = new Set(['pdf']);
// Tabular formats the spreadsheet viewer opens (CSV + the Excel workbook formats).
export const SHEET_EXT = new Set(['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'xlsb', 'ods']);
// Single-file database formats the database viewer opens. The SQLite family is
// fully editable; the rest are recognized so the viewer can name them and explain
// in-app editing isn't available (it sniffs the file header, not the extension).
// Kept in sync with DB_ENGINES in src/main/db-sql.js. `.sql` is deliberately
// absent — it's DDL text, handled by the code editor.
export const DB_EXT = new Set([
  'sqlite', 'sqlite3', 'db', 'db3', 's3db', 'sl3', 'gpkg', 'mbtiles',
  'duckdb', 'ddb', 'mdb', 'accdb', 'mdf', 'ndf', 'ldf',
  'myd', 'myi', 'frm', 'ibd', 'fdb', 'gdb', 'dbf', 'realm', 'bdb', 'nsf', 'odb',
]);
// Godot scene files open the 3D scene editor (a three.js view over the parsed
// .tscn text — see shared/tscn.js). .escn/.tres stay with the text editor:
// .escn is an export artifact and .tres holds a single resource, not a scene.
export const SCENE_EXT = new Set(['tscn']);
// HTML files the editor offers a Preview/Code toggle for: Preview swaps the text
// editor for the page rendered in a webview, Code switches back. Both spellings.
export const HTML_EXT = new Set(['html', 'htm']);

// Filename color by extension. Languages use GitHub Linguist's colors (the dots
// on every repo) so they match what people already recognize; a few are bumped
// brighter to stay readable on the dark tree. Types Linguist has no color for
// (images, audio, configs, archives, docs) are grouped by family — made up here.
const FILE_COLORS = {
  js: '#f1e05a', mjs: '#f1e05a', cjs: '#f1e05a', jsx: '#f1e05a',
  ts: '#4a9eff', tsx: '#4a9eff', py: '#4b8bbe', rb: '#d44', php: '#8892bf',
  java: '#b07219', kt: '#a97bff', go: '#00add8', rs: '#dea584', swift: '#f05138',
  c: '#a8b9cc', h: '#a8b9cc', cpp: '#f34b7d', cc: '#f34b7d', hpp: '#f34b7d', cs: '#5bb464',
  html: '#e8845b', vue: '#41b883', css: '#9d7cd8', scss: '#c6538c', sass: '#c6538c',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', lua: '#7aa3ff', dart: '#00b4ab',
  md: '#7aa6da', json: '#f1e05a', yml: '#cb9a52', yaml: '#cb9a52', toml: '#cb9a52',
  // made-up family colors (no Linguist standard):
  png: '#26a69a', jpg: '#26a69a', jpeg: '#26a69a', gif: '#26a69a', bmp: '#26a69a',
  webp: '#26a69a', svg: '#26a69a', ico: '#26a69a', ai: '#ff9a3c',
  wav: '#ba68c8', ogg: '#ba68c8', mp3: '#ba68c8',
  mp4: '#5c6bc0', m4v: '#5c6bc0', mov: '#5c6bc0', webm: '#5c6bc0', ogv: '#5c6bc0',
  mkv: '#5c6bc0', avi: '#5c6bc0', wmv: '#5c6bc0', flv: '#5c6bc0',
  mpg: '#5c6bc0', mpeg: '#5c6bc0', '3gp': '#5c6bc0', m2ts: '#5c6bc0',
  glb: '#ff7043', gltf: '#ff7043', fbx: '#ff7043', obj: '#ff7043',
  usdz: '#ff7043', stl: '#ff7043', ply: '#ff7043',
  // Godot family — the engine's brand blue
  tscn: '#478cbf', tres: '#478cbf', escn: '#478cbf', gd: '#478cbf', godot: '#478cbf',
  ini: '#9e9e9e', env: '#9e9e9e', conf: '#9e9e9e', cfg: '#9e9e9e',
  zip: '#bcaaa4', tar: '#bcaaa4', gz: '#bcaaa4', rar: '#bcaaa4', '7z': '#bcaaa4',
  txt: '#bdbdbd', pdf: '#e57373', sql: '#e8a33d',
  csv: '#66bb6a', tsv: '#66bb6a', xlsx: '#3fa873', xls: '#3fa873',
  xlsm: '#3fa873', xlsb: '#3fa873', ods: '#3fa873',
  // database files — one shared blue so they read as a family in the tree
  sqlite: '#5a9fd4', sqlite3: '#5a9fd4', db: '#5a9fd4', db3: '#5a9fd4',
  s3db: '#5a9fd4', sl3: '#5a9fd4', gpkg: '#5a9fd4', mbtiles: '#5a9fd4',
  duckdb: '#5a9fd4', ddb: '#5a9fd4', mdb: '#5a9fd4', accdb: '#5a9fd4',
  mdf: '#5a9fd4', dbf: '#5a9fd4', realm: '#5a9fd4', fdb: '#5a9fd4',
};
export function fileColor(name) { return FILE_COLORS[extOf(name)] || 'var(--fg)'; }
