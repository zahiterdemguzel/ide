// File-extension helpers shared across the UI: which extensions are images/audio
// (route to the asset viewer) and per-extension filename colours for the tree.

export function extOf(file) { const m = /\.([^.]+)$/.exec(file); return m ? m[1].toLowerCase() : ''; }

// Images/audio open the asset viewer; everything else gets the text diff/viewer.
export const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
export const AUDIO_EXT = new Set(['wav', 'ogg', 'mp3']);

// Filename color by extension. Languages use GitHub Linguist's colors (the dots
// on every repo) so they match what people already recognize; a few are bumped
// brighter to stay readable on the dark tree. Types Linguist has no color for
// (images, audio, configs, archives, docs) are grouped by family — made up here.
const FILE_COLORS = {
  js: '#f1e05a', mjs: '#f1e05a', cjs: '#f1e05a', jsx: '#f1e05a',
  ts: '#4a9eff', tsx: '#4a9eff', py: '#4b8bbe', rb: '#d44', php: '#8892bf',
  java: '#b07219', kt: '#a97bff', go: '#00add8', rs: '#dea584', swift: '#f05138',
  c: '#a8b9cc', h: '#a8b9cc', cpp: '#f34b7d', cc: '#f34b7d', hpp: '#f34b7d', cs: '#5bb464',
  html: '#e34c26', vue: '#41b883', css: '#9d7cd8', scss: '#c6538c', sass: '#c6538c',
  sh: '#89e051', bash: '#89e051', zsh: '#89e051', lua: '#7aa3ff', dart: '#00b4ab',
  md: '#7aa6da', json: '#f1e05a', yml: '#cb9a52', yaml: '#cb9a52', toml: '#cb9a52',
  // made-up family colors (no Linguist standard):
  png: '#26a69a', jpg: '#26a69a', jpeg: '#26a69a', gif: '#26a69a', bmp: '#26a69a',
  webp: '#26a69a', svg: '#26a69a', ico: '#26a69a',
  wav: '#ba68c8', ogg: '#ba68c8', mp3: '#ba68c8', mp4: '#ba68c8', mov: '#ba68c8',
  ini: '#9e9e9e', env: '#9e9e9e', conf: '#9e9e9e', cfg: '#9e9e9e',
  zip: '#bcaaa4', tar: '#bcaaa4', gz: '#bcaaa4', rar: '#bcaaa4', '7z': '#bcaaa4',
  txt: '#bdbdbd', pdf: '#e57373', csv: '#66bb6a', sql: '#e8a33d',
};
export function fileColor(name) { return FILE_COLORS[extOf(name)] || 'var(--fg)'; }
