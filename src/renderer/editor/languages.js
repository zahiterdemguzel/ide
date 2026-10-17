// Which Monaco language a file opens in. Monaco's own registry
// (monaco.languages.getLanguages()) already knows extensions, filenames and
// filename patterns for ~80 languages, so it's the primary source; this module
// only adds the cases it gets wrong or doesn't know (Godot files, TOML, shell
// dotfiles…). Pure — the registry is passed in — so it's unit-tested without Monaco.

// Extension (lower-case, no dot) → language id, checked before the registry.
export const EXTENSION_OVERRIDES = {
  gd: 'gdscript',
  // Godot's scene/resource/config files are INI-shaped.
  tscn: 'ini', tres: 'ini', godot: 'ini', import: 'ini', cfg: 'ini',
  toml: 'ini', env: 'ini', properties: 'ini', editorconfig: 'ini',
  gdshader: 'cpp', shader: 'cpp', glsl: 'cpp', hlsl: 'cpp', vert: 'cpp', frag: 'cpp',
  zsh: 'shell', fish: 'shell', ksh: 'shell',
  jsonc: 'json', json5: 'json', webmanifest: 'json', har: 'json',
  plist: 'xml', csproj: 'xml', props: 'xml', xaml: 'xml', svg: 'xml',
  mdc: 'markdown',
};

// Whole basenames that carry no telling extension.
export const FILENAME_OVERRIDES = {
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell',
  '.gitconfig': 'ini', '.npmrc': 'ini', '.env': 'ini',
  'cmakelists.txt': 'plaintext',
  'package-lock.json': 'json',
  'tsconfig.json': 'json', 'jsconfig.json': 'json',
};

function baseName(file) {
  const slash = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return file.slice(slash + 1);
}

// Monaco filename patterns are simple globs ("*.config.js", "Dockerfile.*").
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

// `registry` is monaco.languages.getLanguages(): [{ id, extensions, filenames, filenamePatterns }].
// Returns 'plaintext' when nothing matches.
export function languageForFile(file, registry = []) {
  const name = baseName(file);
  const lower = name.toLowerCase();
  if (FILENAME_OVERRIDES[lower]) return FILENAME_OVERRIDES[lower];
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : (dot === 0 ? lower.slice(1) : '');
  if (ext && EXTENSION_OVERRIDES[ext]) return EXTENSION_OVERRIDES[ext];

  for (const lang of registry) {
    if ((lang.filenames || []).some((f) => f.toLowerCase() === lower)) return lang.id;
  }
  for (const lang of registry) {
    if ((lang.filenamePatterns || []).some((p) => globToRegExp(p).test(name))) return lang.id;
  }
  // Longest matching extension wins, so ".d.ts" or ".blade.php" beat ".ts"/".php".
  let best = null;
  let bestLength = 0;
  for (const lang of registry) {
    for (const e of lang.extensions || []) {
      const want = e.toLowerCase();
      if (lower.endsWith(want) && want.length > bestLength) { best = lang.id; bestLength = want.length; }
    }
  }
  return best || 'plaintext';
}

// A short human label for the status bar ("TypeScript", "Python"), taken from
// the registry's aliases with the id as the fallback.
export function languageLabel(id, registry = []) {
  const lang = registry.find((l) => l.id === id);
  return (lang && lang.aliases && lang.aliases[0]) || id;
}
