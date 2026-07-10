console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/highlight.js'); // PERF-TEMP
import { extOf } from './ext.js';

// --- syntax highlighting (highlight.js) ---
// `window.hljs` is the global defined by highlight.min.js (a classic <script>
// loaded before the module graph), so it is available by the time these run.
// Map file extension -> highlight.js language. Unmapped extensions return null,
// which falls back to whole-file auto-detection in the file viewer.
// ponytail: gd -> python (GDScript is python-shaped); no real gdscript grammar
// ships with the common build. Swap in highlightjs-gdscript if it matters.
export const EXT_LANG = {
  py: 'python', pyw: 'python', gd: 'python',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  h: 'cpp', c: 'c', rs: 'rust', go: 'go', swift: 'swift',
  java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', lua: 'lua', pl: 'perl',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', cmd: 'dos', bat: 'dos',
  sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  // Godot config/scene/resource files are all INI-shaped
  import: 'ini', cfg: 'ini', tres: 'ini', tscn: 'ini', godot: 'ini',
  xml: 'xml', html: 'xml', svg: 'xml', css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', r: 'r', m: 'objectivec', mm: 'objectivec',
};

export function langFor(file) {
  const name = EXT_LANG[extOf(file)];
  return name && hljs.getLanguage(name) ? name : null;
}

// Highlight one line in isolation. Used for diff rows, which are fragments with
// no whole-file context (multi-line strings/comments may colour imperfectly).
export function hlLine(text, lang) {
  if (!lang) return null;
  try { return hljs.highlight(text, { language: lang }).value; } catch { return null; }
}

// Highlight a whole block, then split into per-line HTML, re-opening any spans
// left open across a newline so each line stays balanced for its own gutter row.
export function hlLines(code, lang) {
  let html;
  try {
    html = lang ? hljs.highlight(code, { language: lang }).value : hljs.highlightAuto(code).value;
  } catch { return null; }
  const open = [], out = [];
  let line = '';
  // hljs escapes <,>,& so a raw '<' only ever starts a <span ...> or </span>.
  const re = /<span [^>]*>|<\/span>|\n|[^<\n]+/g;
  let m;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok === '\n') { out.push(line + '</span>'.repeat(open.length)); line = open.join(''); }
    else if (tok[1] === '/') { open.pop(); line += tok; }
    else if (tok[0] === '<') { open.push(tok); line += tok; }
    else line += tok;
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}
