// Maps a filename to one of the SVG glyphs in `src/renderer/file-icons/` shown at
// the left of every explorer/search row. Pure (no DOM/Electron) so it's unit-tested
// against the actual icon files on disk — see test/file-icons.test.mjs.
//
// The icons are real artwork pulled from the internet, not hand-drawn:
//  - programming languages -> Simple Icons brand glyphs, single-color (one fill, no gradients)
//  - everything else        -> Lucide glyphs, recolored to read on the dark tree
// Each id below is the basename of a `<id>.svg` file in that folder.

import { extOf } from './ext.js';

// extension -> icon id
const EXT_ICON = {
  // languages
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'react', tsx: 'react',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  rb: 'ruby', erb: 'ruby',
  php: 'php',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', 'c++': 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  cs: 'csharp',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', less: 'css',
  scss: 'sass', sass: 'sass',
  vue: 'vue',
  svelte: 'svelte',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash', ksh: 'bash',
  lua: 'lua',
  dart: 'dart',
  r: 'r',
  scala: 'scala', sc: 'scala',
  pl: 'perl', pm: 'perl',
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  hs: 'haskell',
  md: 'brain', markdown: 'brain', mdx: 'brain',
  gradle: 'gradle',

  // data / config
  json: 'json', jsonc: 'json', json5: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'config', cfg: 'config', conf: 'config', properties: 'config', env: 'config',
  xml: 'xml', xsl: 'xml', xsd: 'xml', plist: 'xml',
  txt: 'text', text: 'text', rst: 'text', adoc: 'text',
  log: 'log',
  pdf: 'pdf',
  csv: 'csv', tsv: 'csv',
  xlsx: 'sheet', xls: 'sheet', xlsm: 'sheet', xlsb: 'sheet', ods: 'sheet',
  sql: 'database', db: 'database', sqlite: 'database', sqlite3: 'database',
  db3: 'database', s3db: 'database', sl3: 'database', gpkg: 'database', mbtiles: 'database',
  duckdb: 'database', ddb: 'database', mdb: 'database', accdb: 'database',
  mdf: 'database', ndf: 'database', ldf: 'database', dbf: 'database',
  realm: 'database', fdb: 'database', gdb: 'database', odb: 'database',
  lock: 'lock',
  key: 'key', pem: 'key', crt: 'key', cert: 'key', p12: 'key',

  // assets
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image',
  webp: 'image', svg: 'image', ico: 'image', tif: 'image', tiff: 'image', avif: 'image',
  wav: 'audio', ogg: 'audio', mp3: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio',
  mp4: 'video', mov: 'video', mkv: 'video', webm: 'video', avi: 'video',
  glb: 'model3d', gltf: 'model3d', fbx: 'model3d', obj: 'model3d',
  usdz: 'model3d', stl: 'model3d', ply: 'model3d',
  zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive',
  rar: 'archive', '7z': 'archive', bz2: 'archive', xz: 'archive',
};

// exact filename (lowercased) -> icon id; wins over the extension table so a
// well-known file gets its real logo (Dockerfile, package.json, …).
const NAME_ICON = {
  dockerfile: 'docker',
  makefile: 'make', 'cmakelists.txt': 'make',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  'package.json': 'nodejs', 'package-lock.json': 'npm',
  '.npmrc': 'npm', 'yarn.lock': 'lock',
  '.editorconfig': 'config', '.prettierrc': 'config', '.eslintrc': 'config', '.babelrc': 'config',
  license: 'text', readme: 'text',
};

function baseName(name) { return String(name).split('/').pop().toLowerCase(); }

// Icon id for a file (accepts a bare name or a repo-relative path).
export function iconForFile(name) {
  const base = baseName(name);
  return NAME_ICON[base] || EXT_ICON[extOf(base)] || 'file';
}

export function iconForFolder(open = false) { return open ? 'folder-open' : 'folder'; }

// Every icon id the mapping can hand back — lets the test assert each one has a
// matching <id>.svg on disk (and that no .svg is left unreferenced).
export const FILE_ICON_IDS = new Set([
  ...Object.values(EXT_ICON), ...Object.values(NAME_ICON),
  'file', 'folder', 'folder-open',
]);
