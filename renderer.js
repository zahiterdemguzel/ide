// Surface any uncaught renderer error in the `npm start` terminal (main.js
// forwards renderer console output there). An error thrown while this file
// first runs would stop later click handlers from ever binding.
window.addEventListener('error', (e) => console.error('Renderer error:', e.message, (e.filename || '') + ':' + e.lineno + ':' + e.colno));
window.addEventListener('unhandledrejection', (e) => console.error('Unhandled promise:', (e.reason && e.reason.message) || e.reason));

const { Terminal } = window;
const FitAddon = window.FitAddon.FitAddon;

const sessions = new Map(); // id -> { term, fit, container, li, dot, state }
let activeId = null;

const listEl = document.getElementById('session-list');
const hostEl = document.getElementById('terminal-host');
const emptyHint = document.getElementById('empty-hint');
const repoLabel = document.getElementById('repo-label');
const sessionBar = document.getElementById('session-bar');
const sessionTitle = document.getElementById('session-title');
const sessionCommitBtn = document.getElementById('session-commit');
const sessionRevertBtn = document.getElementById('session-revert');
const sessionCommitMsg = document.getElementById('session-commit-msg');

const STATE_LABEL = {
  working: 'Working',
  'needs-input': 'Needs input',
  completed: 'Completed',
  pushed: 'Committed / pushed',
};

function termTheme() {
  return {
    background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4',
    selectionBackground: '#264f78',
  };
}

function setState(id, state) {
  const s = sessions.get(id);
  if (!s) return;
  s.state = state;
  s.dot.className = 'dot ' + state;
  s.dot.title = STATE_LABEL[state] || state;
}

function selectSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  hideDiff();
  hideAsset();
  hideWeb();
  emptyHint.style.display = 'none';
  for (const [, o] of sessions) o.container.style.display = o === s ? 'block' : 'none';
  for (const o of listEl.children) o.classList.toggle('active', o.dataset.id === id);
  updateSessionBar();
  fit(s);
  // A hidden xterm can't render its viewport; on reveal it keeps a stale scroll
  // position until new output forces a refresh. Snap to the bottom so the latest
  // output is visible immediately rather than only after the first keystroke.
  // The reveal + fit only take effect on the next frame, so snap there too —
  // a synchronous scrollToBottom here runs against the still-stale viewport.
  s.term.scrollToBottom();
  requestAnimationFrame(() => s.term.scrollToBottom());
  s.term.focus();
}

// Top toolbar: active session's name (its first prompt) + scoped-commit button.
function updateSessionBar() {
  const s = sessions.get(activeId);
  if (!s) { sessionBar.style.display = 'none'; return; }
  sessionBar.style.display = 'flex';
  sessionRevertBtn.classList.remove('armed');
  sessionRevertBtn.textContent = 'Revert';
  const name = s.name || (s.firstPrompt && s.firstPrompt.split('\n')[0]) || ('session ' + s.id.slice(0, 8));
  sessionTitle.textContent = name;
  sessionTitle.title = name;
  const n = s.files.length;
  sessionCommitBtn.textContent = n ? `Commit ${n} file${n > 1 ? 's' : ''}` : 'Commit changes';
}

function fit(s) {
  try {
    s.fit.fit();
    window.api.resize(s.id, s.term.cols, s.term.rows);
  } catch { /* container hidden / closing */ }
}

async function newSession() {
  // probe a size from a temporary fit after open
  const res = await window.api.newSession({ cols: 80, rows: 24 });
  const id = res.id;

  const container = document.createElement('div');
  container.className = 'term-container';
  hostEl.appendChild(container);

  const term = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  term.onData((data) => window.api.sendInput(id, data));
  registerTerminalLinks(term);

  const li = document.createElement('li');
  li.dataset.id = id;
  const dot = document.createElement('span');
  dot.className = 'dot working';
  const label = document.createElement('span');
  label.className = 'sess-label';
  label.textContent = 'session ' + id.slice(0, 8);
  const close = document.createElement('button');
  close.className = 'sess-close';
  close.textContent = '×';
  close.onclick = (e) => { e.stopPropagation(); closeSession(id); };
  li.append(dot, label, close);
  li.onclick = () => selectSession(id);
  listEl.appendChild(li);

  sessions.set(id, { id, term, fit: fitAddon, container, li, dot, label, state: 'working', firstPrompt: '', name: '', files: [] });
  selectSession(id);
}

function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  window.api.killSession(id);
  s.term.dispose();
  s.container.remove();
  s.li.remove();
  sessions.delete(id);
  if (activeId === id) {
    activeId = null;
    const next = sessions.keys().next();
    if (!next.done) selectSession(next.value);
    else { emptyHint.style.display = 'block'; updateSessionBar(); }
  }
}

// --- git pane ---
// Collapse long paths to …trailing/segments that fit within MAX_PATH, keeping whole
// folder/filename segments rather than cutting mid-name. The basename is always kept
// in full unless it alone overflows, in which case its middle is elided (keeping the
// extension). Full path stays in the row's tooltip.
const MAX_PATH = 40;
function shortenPath(file) {
  if (file.length <= MAX_PATH) return file;
  const parts = file.split('/');
  let tail = parts.pop();
  // Basename alone is too long: keep head + extension, elide the middle.
  if (tail.length + 1 > MAX_PATH) {
    const dot = tail.lastIndexOf('.');
    const ext = dot > 0 ? tail.slice(dot) : '';
    const head = tail.slice(0, MAX_PATH - ext.length - 1);
    return head + '…' + ext;
  }
  while (parts.length && ('…' + parts[parts.length - 1] + '/' + tail).length <= MAX_PATH) {
    tail = parts.pop() + '/' + tail;
  }
  return '…' + tail;
}

function gitItem(file, status, staged, action, label) {
  const li = document.createElement('li');
  li.onclick = () => openFile(file, status, staged);
  const st = document.createElement('span');
  st.className = 'git-status g-' + (status === '?' ? 'u' : status);
  st.textContent = status;
  const name = document.createElement('span');
  name.className = 'git-file';
  name.textContent = shortenPath(file);
  name.title = file;

  // Two-click discard: first click arms (red), second click reverts.
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>';
  revert.title = 'Discard changes';
  revert.onclick = async (e) => {
    e.stopPropagation();
    if (!revert.classList.contains('armed')) {
      revert.classList.add('armed');
      li.classList.add('warn');
      revert.title = 'Click again to discard — this cannot be undone';
      return;
    }
    await window.api.gitRevert({ file, untracked: status === '?' });
    refreshGit();
  };

  const btn = document.createElement('button');
  btn.className = 'git-btn';
  btn.textContent = label;
  btn.onclick = async (e) => { e.stopPropagation(); await action(file); refreshGit(); };

  li.append(st, name, revert, btn);
  return li;
}

async function refreshGit() {
  const r = await window.api.gitStatus();
  const stagedEl = document.getElementById('staged-list');
  const unstagedEl = document.getElementById('unstaged-list');
  stagedEl.innerHTML = '';
  unstagedEl.innerHTML = '';
  if (!r.ok) {
    repoLabel.textContent = (r.repo || '') + '  (not a git repo)';
    return;
  }
  repoLabel.textContent = r.repo || '';
  unstagedFiles = r.unstaged;
  revertAllBtn.classList.remove('armed');
  for (const it of r.staged) stagedEl.appendChild(gitItem(it.file, it.status, true, window.api.gitUnstage, '−'));
  for (const it of r.unstaged) unstagedEl.appendChild(gitItem(it.file, it.status, false, window.api.gitStage, '+'));
}

// "Changes" header buttons: stage / discard every unstaged file at once.
let unstagedFiles = [];
const stageAllBtn = document.getElementById('stage-all');
const revertAllBtn = document.getElementById('revert-all');

stageAllBtn.onclick = async () => {
  for (const it of unstagedFiles) await window.api.gitStage(it.file);
  refreshGit();};
revertAllBtn.onclick = async () => {
  if (!revertAllBtn.classList.contains('armed')) {
    revertAllBtn.classList.add('armed');
    document.querySelectorAll('#unstaged-list li').forEach(li => li.classList.add('warn'));
    revertAllBtn.title = 'Click again to discard all changes — this cannot be undone';
    return;
  }
  for (const it of unstagedFiles) await window.api.gitRevert({ file: it.file, untracked: it.status === '?' });
  refreshGit();};

// --- file explorer (left, below sessions) ---
// Lazy tree: each folder fetches its children the first time it's expanded.
const fileTree = document.getElementById('file-tree');

async function loadDir(rel, container, depth) {
  const r = await window.api.listDir(rel);
  container.innerHTML = '';
  if (!r.ok) return;
  for (const e of r.entries) {
    const childRel = rel ? rel + '/' + e.name : e.name;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.style.paddingLeft = (depth * 12 + 8) + 'px';
    const twist = document.createElement('span');
    twist.className = 'tree-twist';
    twist.textContent = e.dir ? '▸' : '';
    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = e.name;
    name.title = e.name;
    if (!e.dir) name.style.color = fileColor(e.name);
    row.append(twist, name);
    container.appendChild(row);

    if (e.dir) {
      const kids = document.createElement('div');
      kids.style.display = 'none';
      container.appendChild(kids);
      let loaded = false;
      row.onclick = async () => {
        const open = kids.style.display === 'none';
        kids.style.display = open ? 'block' : 'none';
        twist.textContent = open ? '▾' : '▸';
        if (open && !loaded) { loaded = true; await loadDir(childRel, kids, depth + 1); }
      };
    } else {
      row.onclick = () => {
        document.querySelectorAll('.tree-row.sel').forEach((x) => x.classList.remove('sel'));
        row.classList.add('sel');
        openFromTree(childRel);
      };
    }
  }
}

// Reuse the media viewer for images/audio, the diff container for text. `jump`
// (optional { line, term }) scrolls a reference hit into view and marks the word.
function openFromTree(file, jump) {
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showFile(file, jump);
}

function refreshTree() { loadDir('', fileTree, 0); }
document.getElementById('files-refresh').onclick = refreshTree;

// Collapse every open folder, keeping already-loaded children in the DOM.
function collapseAll() {
  for (const row of fileTree.querySelectorAll('.tree-row')) {
    const twist = row.querySelector('.tree-twist');
    if (twist && twist.textContent === '▾') {
      twist.textContent = '▸';
      if (row.nextElementSibling) row.nextElementSibling.style.display = 'none';
    }
  }
}
document.getElementById('files-collapse').onclick = collapseAll;

// Search: filenames first (fast, recursive), then references (git grep, slower)
// streamed in under a "References" heading once they arrive. A run token guards
// against a slow refs response landing after the query already changed.
const searchInput = document.getElementById('file-search');
const searchResults = document.getElementById('search-results');
let searchRun = 0;

function resultRow(file, lineNo, text, term) {
  const row = document.createElement('div');
  row.className = 'tree-row search-row';
  const name = document.createElement('span');
  name.className = 'tree-name';
  name.style.color = fileColor(file);
  name.textContent = lineNo ? `${file}:${lineNo}` : file;
  name.title = file;
  row.appendChild(name);
  if (text) {
    const snip = document.createElement('span');
    snip.className = 'search-snippet';
    snip.textContent = text.trim();
    row.appendChild(snip);
  }
  row.onclick = () => {
    document.querySelectorAll('.tree-row.sel').forEach((x) => x.classList.remove('sel'));
    row.classList.add('sel');
    openFromTree(file, lineNo ? { line: lineNo, term } : null);
  };
  return row;
}

function searchHeading(label) {
  const h = document.createElement('div');
  h.className = 'search-heading';
  h.textContent = label;
  return h;
}

async function runSearch(q) {
  const run = ++searchRun;
  if (!q) { searchResults.hidden = true; searchResults.innerHTML = ''; fileTree.hidden = false; return; }
  fileTree.hidden = true;
  searchResults.hidden = false;
  searchResults.innerHTML = '';

  const nameRes = await window.api.searchNames(q);
  if (run !== searchRun) return;
  searchResults.appendChild(searchHeading(`Files (${nameRes.files.length})`));
  if (!nameRes.files.length) searchResults.appendChild(searchHeading('— no matches'));
  for (const f of nameRes.files) searchResults.appendChild(resultRow(f));

  // References run in the background; don't block the filename results on them.
  const refsHeading = searchHeading('References…');
  searchResults.appendChild(refsHeading);
  window.api.searchRefs(q).then((refRes) => {
    if (run !== searchRun) return;
    const matches = refRes.matches || [];
    refsHeading.textContent = `References (${matches.length})`;
    if (!matches.length) searchResults.appendChild(searchHeading('— no matches'));
    for (const m of matches) searchResults.appendChild(resultRow(m.file, m.line, m.text, q));
  });
}

let searchTimer;
searchInput.oninput = (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 150);
};

// --- center overlays (diff / asset) over the terminal ---
function hideSessionViews() {
  for (const o of sessions.values()) o.container.style.display = 'none';
  emptyHint.style.display = 'none';
}

// Route a clicked git file: images/audio open the asset viewer, everything
// else gets the text diff (a binary diff would just be noise).
const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
const AUDIO_EXT = new Set(['wav', 'ogg', 'mp3']);
function extOf(file) { const m = /\.([^.]+)$/.exec(file); return m ? m[1].toLowerCase() : ''; }

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
function fileColor(name) { return FILE_COLORS[extOf(name)] || 'var(--fg)'; }
function openFile(file, status, staged) {
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showDiff(file, status, staged);
}

// --- syntax highlighting (highlight.js) ---
// `hljs` is the global defined by highlight.min.js (loaded before this script);
// don't redeclare it here — a top-level `const hljs` collides with that global
// and throws a SyntaxError that aborts this entire file.
// Map file extension -> highlight.js language. Unmapped extensions return null,
// which falls back to whole-file auto-detection in the file viewer.
// ponytail: gd -> python (GDScript is python-shaped); no real gdscript grammar
// ships with the common build. Swap in highlightjs-gdscript if it matters.
const EXT_LANG = {
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
function langFor(file) {
  const name = EXT_LANG[extOf(file)];
  return name && hljs.getLanguage(name) ? name : null;
}

// Highlight one line in isolation. Used for diff rows, which are fragments with
// no whole-file context (multi-line strings/comments may colour imperfectly).
function hlLine(text, lang) {
  if (!lang) return null;
  try { return hljs.highlight(text, { language: lang }).value; } catch { return null; }
}

// Highlight a whole block, then split into per-line HTML, re-opening any spans
// left open across a newline so each line stays balanced for its own gutter row.
function hlLines(code, lang) {
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

// --- diff view ---
const diffView = document.getElementById('diff-view');
const diffBody = document.getElementById('diff-body');

function hideDiff() { diffView.style.display = 'none'; }

async function showDiff(file, status, staged) {
  const r = await window.api.gitDiff({ file, staged, untracked: status === '?' });
  document.getElementById('diff-file').textContent = file;
  renderDiff(r.stdout || r.stderr || '(no changes)', langFor(file));
  hideAsset();
  hideWeb();
  hideSessionViews();
  diffView.style.display = 'flex';
}

function diffRow(oldNo, newNo, cls, text, lang) {
  const row = document.createElement('div');
  row.className = 'diff-row ' + cls;
  row.innerHTML =
    `<span class="diff-ln">${oldNo || ''}</span>` +
    `<span class="diff-ln">${newNo || ''}</span>`;
  const code = document.createElement('span');
  code.className = 'diff-code';
  const hl = cls === 'hunk' ? null : hlLine(text, lang); // hunk headers are git metadata
  if (hl != null) code.innerHTML = hl; else code.textContent = text;
  row.appendChild(code);
  return row;
}

// Render git's unified diff: track old/new line numbers from @@ hunk headers,
// colour +/- lines, skip the file-header noise (diff/index/--- /+++).
function renderDiff(text, lang) {
  diffBody.innerHTML = '';
  let oldNo = 0, newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      diffBody.appendChild(diffRow('', '', 'hunk', line, lang));
      continue;
    }
    if (line.startsWith('+')) diffBody.appendChild(diffRow('', newNo++, 'add', line.slice(1), lang));
    else if (line.startsWith('-')) diffBody.appendChild(diffRow(oldNo++, '', 'del', line.slice(1), lang));
    else diffBody.appendChild(diffRow(oldNo++, newNo++, 'ctx', line.slice(1), lang));
  }
}

// Read-only file view for the explorer: reuse the diff container, render each
// line with a single line-number gutter (no +/- colouring). `jump`
// (optional { line, term }) scrolls to that line and marks the matched word.
async function showFile(file, jump) {
  const r = await window.api.readText(file);
  document.getElementById('diff-file').textContent = file;
  let text = r.ok ? r.text : (r.error || '(could not read)');
  let lang = langFor(file);
  if (!r.ok || text.includes('\\u0000')) {   // can't highlight an error or binary
    if (r.ok) text = '(binary file)';         // ponytail: null-byte sniff is enough
    lang = null;
  }
  renderText(text, lang);
  hideAsset();
  hideWeb();
  hideSessionViews();
  diffView.style.display = 'flex';
  if (jump) jumpToLine(jump.line, jump.term);
}

// Scroll a reference hit into view and visually mark the matched word inside it.
function jumpToLine(line, term) {
  const row = diffBody.children[(line || 1) - 1];
  if (!row) return;
  row.classList.add('diff-hit');
  if (term) markTerm(row.querySelector('.diff-code'), term);
  row.scrollIntoView({ block: 'center' });
}

// Wrap each case-insensitive occurrence of `term` in <mark>, walking text nodes
// so we don't disturb hljs's existing <span> structure.
function markTerm(el, term) {
  if (!el || !term) return;
  const needle = term.toLowerCase();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.toLowerCase().includes(needle)) nodes.push(n);
  }
  for (const node of nodes) {
    const text = node.nodeValue, low = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0, idx;
    while ((idx = low.indexOf(needle, i)) !== -1) {
      if (idx > i) frag.appendChild(document.createTextNode(text.slice(i, idx)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(idx, idx + needle.length);
      frag.appendChild(mark);
      i = idx + needle.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    node.parentNode.replaceChild(frag, node);
  }
}

function renderText(text, lang) {
  diffBody.innerHTML = '';
  // ponytail: cap render at 5000 lines; virtualize only if huge files matter
  const lines = text.split('\n').slice(0, 5000);
  // Known extension -> that grammar; null lang -> hlLines auto-detects.
  const hl = hlLines(lines.join('\n'), lang);
  let n = 1;
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement('div');
    row.className = 'diff-row';
    const ln = document.createElement('span');
    ln.className = 'diff-ln';
    ln.textContent = n++;
    const code = document.createElement('span');
    code.className = 'diff-code';
    if (hl && hl[i] != null) code.innerHTML = hl[i]; else code.textContent = lines[i];
    row.append(ln, code);
    diffBody.appendChild(row);
  }
}

function closeOverlay() {
  if (activeId) selectSession(activeId);
  else { hideDiff(); hideAsset(); hideWeb(); emptyHint.style.display = 'block'; }
}
document.getElementById('diff-close').onclick = closeOverlay;
document.getElementById('asset-close').onclick = closeOverlay;

// --- inline web browser (Ctrl+clicked http/https links) ---
// A <webview> runs the page out-of-process, so the host CSP doesn't restrict it.
const webView = document.getElementById('web-view');
const webFrame = document.getElementById('web-frame');
const webUrlEl = document.getElementById('web-url');

function hideWeb() { webView.style.display = 'none'; webFrame.src = 'about:blank'; }

function showWeb(url) {
  hideDiff();
  hideAsset();
  hideSessionViews();
  webUrlEl.textContent = url;
  webUrlEl.title = url;
  webFrame.src = url;
  webView.style.display = 'flex';
}

// Keep the address bar in sync as the guest page navigates.
const syncWebUrl = (e) => { webUrlEl.textContent = e.url; webUrlEl.title = e.url; };
webFrame.addEventListener('did-navigate', syncWebUrl);
webFrame.addEventListener('did-navigate-in-page', syncWebUrl);
document.getElementById('web-back').onclick = () => { try { if (webFrame.canGoBack()) webFrame.goBack(); } catch {} };
document.getElementById('web-fwd').onclick = () => { try { if (webFrame.canGoForward()) webFrame.goForward(); } catch {} };
document.getElementById('web-reload').onclick = () => { try { webFrame.reload(); } catch {} };
document.getElementById('web-external').onclick = () => window.api.openExternal(webUrlEl.textContent);
document.getElementById('web-close').onclick = closeOverlay;

// --- terminal Ctrl+click links (file paths + web URLs) ---
// VS Code feel: links only light up while Ctrl (Cmd on mac) is held, so normal
// hover and drag-to-select are untouched. provideLinks is gated on that key
// state; activating a link routes to the file viewer or the inline browser.
let linkModDown = false;
const onMac = navigator.platform.toLowerCase().includes('mac');
window.addEventListener('keydown', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) linkModDown = true; });
window.addEventListener('keyup', (e) => { if (e.key === (onMac ? 'Meta' : 'Control')) linkModDown = false; });
window.addEventListener('blur', () => { linkModDown = false; });

const URL_RE = /\bhttps?:\/\/[^\s)<>"'`]+/gi;
// A path-ish token: an optional drive/anchor, then path chars, with optional
// trailing :line[:col]. Over-matches plain words; looksLikePath() filters those.
const PATH_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/]|~[\\/])?[\w.@+-]+(?:[\\/][\w.@+-]+)*(?::\d+(?::\d+)?)?/g;

// Extensions that make a separator-less token (e.g. "renderer.js") a real link.
const PATH_EXT = new Set([
  ...Object.keys(EXT_LANG), ...IMG_EXT, ...AUDIO_EXT,
  'txt', 'log', 'lock', 'env', 'conf', 'gd', 'tscn', 'tres', 'godot',
]);

function looksLikePath(raw) {
  const core = raw.replace(/:\d+(?::\d+)?$/, '');
  if (core.length < 2) return false;
  if (/[\\/]/.test(core)) return true;        // has a separator -> treat as a path
  const ext = extOf(core);
  return !!ext && PATH_EXT.has(ext);          // bare filename with a known extension
}

// Find non-overlapping URL (first) then path matches in one terminal line.
function findTerminalLinks(text) {
  const out = [];
  const taken = new Array(text.length).fill(false);
  const scan = (re, kind, keep) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (keep && !keep(m[0])) continue;
      let free = true;
      for (let i = s; i < e; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      for (let i = s; i < e; i++) taken[i] = true;
      out.push({ start: s, end: e, raw: m[0], kind });
    }
  };
  scan(URL_RE, 'url');
  scan(PATH_RE, 'path', looksLikePath);
  return out;
}

async function openTerminalLink(kind, raw) {
  if (kind === 'url') { showWeb(raw); return; }
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(raw); // split a trailing :line[:col]
  const p = m ? m[1] : raw;
  const line = m ? Number(m[2]) : null;
  const r = await window.api.resolveLinkPath(p);
  if (!r || !r.ok || !r.isFile) return;
  if (r.inRepo) openFromTree(r.rel, line ? { line, term: null } : null);
  else window.api.openExternal(r.abs);
}

function registerTerminalLinks(term) {
  term.registerLinkProvider({
    provideLinks(y, callback) {
      if (!linkModDown) return callback(undefined);
      const bufLine = term.buffer.active.getLine(y - 1);
      if (!bufLine) return callback(undefined);
      const text = bufLine.translateToString(true);
      const links = findTerminalLinks(text).map((f) => ({
        text: f.raw,
        range: { start: { x: f.start + 1, y }, end: { x: f.end, y } },
        decorations: { pointerCursor: true, underline: true },
        activate: (event) => { event.preventDefault(); openTerminalLink(f.kind, f.raw); },
      }));
      callback(links.length ? links : undefined);
    },
  });
}

// --- asset view: image zoom / pixel editor / audio waveform ---
const assetView = document.getElementById('asset-view');
const assetBody = document.getElementById('asset-body');
const assetTools = document.getElementById('asset-tools');

// Clearing the body removes any <audio>, stopping playback and freeing memory.
function hideAsset() { removePixelKeys(); assetView.style.display = 'none'; assetBody.innerHTML = ''; assetTools.innerHTML = ''; }

async function showAsset(file, ext) {
  removePixelKeys();
  hideDiff();
  hideWeb();
  hideSessionViews();
  document.getElementById('asset-file').textContent = file;
  assetTools.innerHTML = '';
  assetBody.innerHTML = '';
  assetView.style.display = 'flex';

  const r = await window.api.readAsset(file);
  if (!r.ok) { assetBody.textContent = r.error || 'Could not read file'; return; }
  const dataUrl = `data:${r.mime};base64,${r.base64}`;

  if (AUDIO_EXT.has(ext)) { renderAudio(dataUrl, r.base64); return; }

  const img = new Image();
  // PNGs small enough to paint pixel-by-pixel get the editor; the rest, zoom.
  img.onload = () => {
    if (ext === 'png' && img.naturalWidth < 200 && img.naturalHeight < 200) renderPixelEditor(file, img);
    else renderZoom(img);
  };
  img.onerror = () => { assetBody.textContent = 'Could not decode image'; };
  img.src = dataUrl;
}

function assetBtn(text, onclick) {
  const b = document.createElement('button');
  b.className = 'asset-btn';
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function renderZoom(img) {
  let scale = 1;
  img.className = 'zoom-img';
  const wrap = document.createElement('div');
  wrap.className = 'zoom-wrap';
  wrap.appendChild(img);
  assetBody.appendChild(wrap);

  const pct = document.createElement('span');
  pct.className = 'asset-pct';
  const apply = () => {
    img.style.width = (img.naturalWidth * scale) + 'px';
    pct.textContent = Math.round(scale * 100) + '%';
  };
  assetTools.append(
    assetBtn('−', () => { scale = Math.max(0.1, scale / 1.25); apply(); }),
    pct,
    assetBtn('+', () => { scale = Math.min(32, scale * 1.25); apply(); }),
    assetBtn('Reset', () => { scale = 1; apply(); }),
  );
  apply();
}

const PALETTE = ['#000000', '#ffffff', '#f85149', '#3fb950', '#0e639c', '#e2c08d', '#a371f7', '#6e7681'];

const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgbToHex = (r, g, b) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
// amt>0 lightens toward white, <0 darkens toward black — works at the #000/#fff extremes a plain multiply can't escape.
const shade = (hex, amt) => { const [r, g, b] = hexToRgb(hex), t = amt > 0 ? 255 : 0, f = Math.abs(amt); return rgbToHex(r + (t - r) * f, g + (t - g) * f, b + (t - b) * f); };

let pixelKeyHandler = null;
function removePixelKeys() { if (pixelKeyHandler) { document.removeEventListener('keydown', pixelKeyHandler); pixelKeyHandler = null; } }

function renderPixelEditor(file, img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  let scale = Math.max(1, Math.floor(384 / Math.max(w, h))); // blow tiny art up to ~screen size
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.className = 'pixel-canvas';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const applyScale = () => { canvas.style.width = (w * scale) + 'px'; canvas.style.height = (h * scale) + 'px'; };
  applyScale();

  let color = PALETTE[0];
  let erasing = false;

  // ponytail: 50-state ImageData ring — full-frame snapshots, fine for sub-200px art; switch to per-stroke diffs if memory bites.
  const undoStack = [], redoStack = [];
  const pushUndo = () => { undoStack.push(ctx.getImageData(0, 0, w, h)); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0; };
  const undo = () => { if (undoStack.length) { redoStack.push(ctx.getImageData(0, 0, w, h)); ctx.putImageData(undoStack.pop(), 0, 0); } };
  const redo = () => { if (redoStack.length) { undoStack.push(ctx.getImageData(0, 0, w, h)); ctx.putImageData(redoStack.pop(), 0, 0); } };

  const coords = (e) => {
    const rect = canvas.getBoundingClientRect();
    return [Math.floor((e.clientX - rect.left) / scale), Math.floor((e.clientY - rect.top) / scale)];
  };
  const inBounds = (px, py) => px >= 0 && py >= 0 && px < w && py < h;
  const paintAt = (e) => {
    const [px, py] = coords(e);
    if (!inBounds(px, py)) return;
    if (erasing) ctx.clearRect(px, py, 1, 1);
    else { ctx.fillStyle = color; ctx.fillRect(px, py, 1, 1); }
  };
  const pickAt = (e) => {
    const [px, py] = coords(e);
    if (!inBounds(px, py)) return;
    const d = ctx.getImageData(px, py, 1, 1).data;
    if (d[3]) selectColor(rgbToHex(d[0], d[1], d[2])); // skip transparent pixels — no color to pick
  };

  let down = false, panning = false, panX = 0, panY = 0, scrollX = 0, scrollY = 0, panMoved = false;
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    if (e.button === 1) { // middle: drag to pan, click (no drag) to eyedrop
      e.preventDefault();
      panning = true; panMoved = false;
      panX = e.clientX; panY = e.clientY; scrollX = assetBody.scrollLeft; scrollY = assetBody.scrollTop;
    } else { down = true; pushUndo(); paintAt(e); }
  };
  canvas.onpointermove = (e) => {
    if (panning) {
      const dx = e.clientX - panX, dy = e.clientY - panY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) panMoved = true;
      assetBody.scrollLeft = scrollX - dx; assetBody.scrollTop = scrollY - dy;
    } else if (down) paintAt(e);
  };
  canvas.onpointerup = (e) => {
    if (panning && !panMoved) pickAt(e); // middle click without dragging = eyedropper
    down = false; panning = false;
  };
  canvas.onpointercancel = () => { down = false; panning = false; };
  canvas.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); }; // block middle-click autoscroll
  canvas.onauxclick = (e) => { if (e.button === 1) e.preventDefault(); };

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    scale = Math.max(1, Math.min(48, e.deltaY < 0 ? scale + 1 : scale - 1));
    applyScale();
  }, { passive: false });

  removePixelKeys();
  pixelKeyHandler = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  document.addEventListener('keydown', pixelKeyHandler);

  const swatches = document.createElement('div');
  swatches.className = 'palette';
  const eraseBtn = assetBtn('Erase', () => { erasing = !erasing; eraseBtn.classList.toggle('on', erasing); });
  const selectColor = (c) => {
    color = c; erasing = false; eraseBtn.classList.remove('on');
    picker.value = c;
    for (const sw of swatches.children) sw.classList.toggle('sel', sw.dataset.c === c);
  };
  for (const c of PALETTE) {
    const sw = document.createElement('button');
    sw.className = 'swatch';
    sw.dataset.c = c;
    sw.style.background = c;
    sw.onclick = () => selectColor(c);
    swatches.appendChild(sw);
  }
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'asset-picker';
  picker.value = color;
  picker.oninput = () => selectColor(picker.value);

  const darkBtn = assetBtn('−', () => selectColor(shade(color, -0.12)));
  const lightBtn = assetBtn('+', () => selectColor(shade(color, 0.12)));

  const saved = document.createElement('span');
  saved.className = 'asset-pct';
  const saveBtn = assetBtn('Save', async () => {
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const r = await window.api.writeAsset(file, base64);
    saved.textContent = r.ok ? 'Saved' : (r.error || 'Save failed');
    if (r.ok) refreshGit();  });

  assetTools.append(swatches, picker, darkBtn, lightBtn, eraseBtn, assetBtn('↶', undo), assetBtn('↷', redo), saveBtn, saved);
  const stage = document.createElement('div');
  stage.className = 'pixel-stage';
  stage.appendChild(canvas);
  assetBody.appendChild(stage);
  selectColor(color);
}

let audioCtx;
function renderAudio(dataUrl, base64) {
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.src = dataUrl;
  audio.className = 'asset-audio';
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform';
  assetBody.append(audio, canvas);
  canvas.width = assetBody.clientWidth - 24;
  canvas.height = 160;

  (async () => {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const buf = await audioCtx.decodeAudioData(bytes.buffer);
      drawWaveform(canvas, buf);
    } catch (e) {
      const c = canvas.getContext('2d');
      c.fillStyle = '#858585';
      c.fillText('Waveform unavailable: ' + e.message, 8, 20);
    }
  })();
}

// Peak-per-column waveform: scan each pixel's slice of samples for min/max.
function drawWaveform(canvas, audioBuffer) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, mid = H / 2;
  const data = audioBuffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / W));
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0e639c';
  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let i = 0; i < step; i++) {
      const v = data[x * step + i] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.fillRect(x, (1 + min) * mid, 1, Math.max(1, (max - min) * mid));
  }
}

// --- top run toolbar (.vscode/launch.json + tasks.json) ---
// One button per launch config, a separator, then one per task. Clicking a
// button opens an external terminal running that config/task (main builds the
// command). Rebuilt on startup and whenever the open folder changes.
const toolbarRuns = document.getElementById('toolbar-runs');

function runButton(kind, name, compound) {
  const b = document.createElement('button');
  b.className = 'tool-btn ' + kind;
  b.title = (kind === 'launch' ? (compound ? 'Launch compound: ' : 'Launch: ') : 'Task: ')
    + name + ' — opens an external terminal';
  const ico = document.createElement('span');
  ico.className = 'tool-ico';
  ico.textContent = kind === 'launch' ? '▶' : '⚙';
  const label = document.createElement('span');
  label.textContent = name;
  b.append(ico, label);
  b.onclick = async () => {
    b.classList.add('busy');
    const r = await window.api.runConfig({ kind, name });
    b.classList.remove('busy');
    if (!r || !r.ok) console.error('run-config failed:', (r && r.error) || 'unknown');
  };
  return b;
}

async function loadToolbar() {
  const r = await window.api.getRunConfigs();
  toolbarRuns.innerHTML = '';
  const launch = r.launch || [], tasks = r.tasks || [];
  if (!launch.length && !tasks.length) {
    const hint = document.createElement('span');
    hint.className = 'toolbar-hint';
    hint.textContent = 'No .vscode/launch.json or tasks.json in this folder';
    toolbarRuns.appendChild(hint);
    return;
  }
  for (const c of launch) toolbarRuns.appendChild(runButton('launch', c.name, c.compound));
  if (launch.length && tasks.length) {
    const sep = document.createElement('span');
    sep.className = 'tool-sep';
    toolbarRuns.appendChild(sep);
  }
  for (const t of tasks) toolbarRuns.appendChild(runButton('task', t.name));
}

// --- wiring ---
window.api.onPtyData(({ id, data }) => {
  const s = sessions.get(id);
  if (s) s.term.write(data);
});
window.api.onStatus(({ id, state }) => setState(id, state));
window.api.onSessionMeta(({ id, firstPrompt, files }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.firstPrompt = firstPrompt;
  s.files = files;
  if (id === activeId) updateSessionBar();
});
window.api.onSessionName(({ id, name }) => {
  const s = sessions.get(id);
  if (!s) return;
  s.name = name;
  s.label.textContent = name;
  if (id === activeId) updateSessionBar();
});

const gitMsgEl = document.getElementById('git-msg');
function showGitMsg(text, ok) {
  gitMsgEl.textContent = text;
  gitMsgEl.className = 'git-msg ' + (ok ? 'ok' : 'err');
}

sessionCommitBtn.onclick = async () => {
  if (!activeId) return;
  sessionCommitMsg.textContent = '';
  const r = await window.api.commitSession(activeId);
  sessionCommitMsg.textContent = r.ok ? 'Committed' : (r.stderr || 'Commit failed');
  sessionCommitMsg.className = 'git-msg ' + (r.ok ? 'ok' : 'err');
  if (r.ok) setState(activeId, 'pushed');
  refreshGit();};

// Two-click revert: first click arms, second de-applies just this session's edits.
sessionRevertBtn.onclick = async () => {
  if (!activeId) return;
  if (!sessionRevertBtn.classList.contains('armed')) {
    sessionRevertBtn.classList.add('armed');
    sessionRevertBtn.textContent = 'Revert — sure?';
    return;
  }
  sessionRevertBtn.classList.remove('armed');
  sessionRevertBtn.textContent = 'Revert';
  sessionCommitMsg.textContent = '';
  const r = await window.api.revertSession(activeId);
  const skipped = r.skipped && r.skipped.length;
  sessionCommitMsg.textContent = !r.ok ? (r.stderr || 'Revert failed')
    : skipped ? `Reverted; ${skipped} file${skipped > 1 ? 's' : ''} skipped (also edited by another session)`
    : 'Reverted';
  sessionCommitMsg.className = 'git-msg ' + (r.ok && !skipped ? 'ok' : 'err');
  refreshGit();};

document.getElementById('new-session').onclick = newSession;
document.getElementById('git-refresh').onclick = refreshGit;
document.getElementById('git-commit').onclick = async () => {
  const box = document.getElementById('commit-msg');
  const msg = box.value.trim();
  if (!msg) { showGitMsg('Enter a commit message', false); return; }
  const r = await window.api.gitCommit(msg);
  showGitMsg(r.ok ? 'Committed' : (r.stderr || 'Commit failed'), r.ok);
  if (r.ok) box.value = '';
  refreshGit();};
document.getElementById('git-undo').onclick = async () => {
  const r = await window.api.gitUndo();
  showGitMsg(r.ok ? 'Last commit undone' : (r.stderr || 'Undo failed'), r.ok);
  refreshGit();};
document.getElementById('git-push').onclick = async () => {
  showGitMsg('Pushing…', true);
  const r = await window.api.gitPush();
  showGitMsg(r.ok ? 'Pushed' : (r.stderr || 'Push failed'), r.ok);
};
document.getElementById('open-folder').onclick = async () => {
  try {
    const r = await window.api.openFolder();
    if (r.error) console.error('open-folder:', r.error);
    if (!r.canceled) { repoLabel.textContent = r.repo; refreshGit(); refreshTree(); loadToolbar(); }
  } catch (err) {
    console.error('open-folder click failed:', err);
  }
};

window.addEventListener('resize', () => { if (activeId) fit(sessions.get(activeId)); fitConsole(); });

// --- resizable panes ---
// Drag a gutter to resize the pane on its near side; clamp to [min, max()].
// read() = current size px, write(px) sets a CSS var; sign flips for gutters
// whose pane is on the far side (the right column shrinks as you drag right).
const appEl = document.getElementById('app');
const sidebarEl = document.getElementById('sidebar');
const gitEl = document.getElementById('git');
const CENTER_MIN = 200;

function resizer(gutter, axis, sign, read, write, min, max) {
  gutter.onpointerdown = (e) => {
    e.preventDefault();
    gutter.setPointerCapture(e.pointerId);
    gutter.classList.add('dragging');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const base = read();
    const move = (ev) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      write(Math.max(min, Math.min(max(), base + sign * d)) + 'px');
      if (activeId) fit(sessions.get(activeId)); // ponytail: reflow live; throttle if janky
      fitConsole();
    };
    const up = (ev) => {
      gutter.classList.remove('dragging');
      gutter.releasePointerCapture(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  };
}

resizer(document.getElementById('gutter-left'), 'x', +1,
  () => sidebarEl.getBoundingClientRect().width,
  (v) => appEl.style.setProperty('--left', v),
  150, () => window.innerWidth - gitEl.getBoundingClientRect().width - CENTER_MIN);

resizer(document.getElementById('gutter-right'), 'x', -1,
  () => gitEl.getBoundingClientRect().width,
  (v) => appEl.style.setProperty('--right', v),
  180, () => window.innerWidth - sidebarEl.getBoundingClientRect().width - CENTER_MIN);

resizer(document.getElementById('gutter-sess'), 'y', +1,
  () => document.getElementById('sessions-pane').getBoundingClientRect().height,
  (v) => sidebarEl.style.setProperty('--sess-h', v),
  80, () => sidebarEl.getBoundingClientRect().height - 140);

// Console sits on the far (bottom) side of its gutter, so dragging down shrinks it.
resizer(document.getElementById('gutter-console'), 'y', -1,
  () => document.getElementById('git-console').getBoundingClientRect().height,
  (v) => gitEl.style.setProperty('--console-h', v),
  80, () => gitEl.getBoundingClientRect().height - 160);

// --- git-pane console: one shared interactive shell terminal ---
let consoleTerm = null, consoleFit = null;
function fitConsole() {
  if (!consoleTerm) return;
  try {
    consoleFit.fit();
    window.api.termResize(consoleTerm.cols, consoleTerm.rows);
  } catch { /* host hidden / zero-size */ }
}
async function startShell() {
  consoleFit.fit();
  await window.api.startTerm({ cols: consoleTerm.cols, rows: consoleTerm.rows });
  fitConsole();
}
function initConsole() {
  consoleTerm = new Terminal({ fontSize: 13, fontFamily: 'Consolas, monospace', theme: termTheme(), cursorBlink: true });
  consoleFit = new FitAddon();
  consoleTerm.loadAddon(consoleFit);
  consoleTerm.open(document.getElementById('console-host'));
  consoleTerm.onData((d) => window.api.termInput(d));
  window.api.onTermData((d) => consoleTerm.write(d));
  window.api.onTermExit(() => startShell()); // respawn a fresh shell if the user exits it
  document.getElementById('term-clear').onclick = () => { consoleTerm.clear(); consoleTerm.focus(); };
  startShell();
}
initConsole();

refreshGit();
refreshTree();
loadToolbar();
// ponytail: poll while focused; a file watcher would be more code for no real gain
setInterval(() => { if (document.hasFocus()) refreshGit(); }, 3000);