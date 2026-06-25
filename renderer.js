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
const sessionCommitMsg = document.getElementById('session-commit-msg');

const STATE_LABEL = {
  working: 'Working',
  'needs-input': 'Needs input',
  completed: 'Completed',
  pushed: 'Pushed',
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
  emptyHint.style.display = 'none';
  for (const [, o] of sessions) o.container.style.display = o === s ? 'block' : 'none';
  for (const o of listEl.children) o.classList.toggle('active', o.dataset.id === id);
  updateSessionBar();
  fit(s);
  s.term.focus();
}

// Top toolbar: active session's name (its first prompt) + scoped-commit button.
function updateSessionBar() {
  const s = sessions.get(activeId);
  if (!s) { sessionBar.style.display = 'none'; return; }
  sessionBar.style.display = 'flex';
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
function gitItem(file, status, staged, action, label) {
  const li = document.createElement('li');
  li.onclick = () => openFile(file, status, staged);
  const st = document.createElement('span');
  st.className = 'git-status g-' + (status === '?' ? 'u' : status);
  st.textContent = status;
  const name = document.createElement('span');
  name.className = 'git-file';
  name.textContent = file;
  name.title = file;

  // Two-click discard: first click arms (red), second click reverts.
  const revert = document.createElement('button');
  revert.className = 'git-btn git-revert';
  revert.textContent = '⟲';
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

// Reuse the media viewer for images/audio, the diff container for text.
function openFromTree(file) {
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showFile(file);
}

function refreshTree() { loadDir('', fileTree, 0); }
document.getElementById('files-refresh').onclick = refreshTree;

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
function openFile(file, status, staged) {
  const ext = extOf(file);
  if (IMG_EXT.has(ext) || AUDIO_EXT.has(ext)) showAsset(file, ext);
  else showDiff(file, status, staged);
}

// --- diff view ---
const diffView = document.getElementById('diff-view');
const diffBody = document.getElementById('diff-body');

function hideDiff() { diffView.style.display = 'none'; }

async function showDiff(file, status, staged) {
  const r = await window.api.gitDiff({ file, staged, untracked: status === '?' });
  document.getElementById('diff-file').textContent = file;
  renderDiff(r.stdout || r.stderr || '(no changes)');
  hideAsset();
  hideSessionViews();
  diffView.style.display = 'flex';
}

function diffRow(oldNo, newNo, cls, text) {
  const row = document.createElement('div');
  row.className = 'diff-row ' + cls;
  row.innerHTML =
    `<span class="diff-ln">${oldNo || ''}</span>` +
    `<span class="diff-ln">${newNo || ''}</span>`;
  const code = document.createElement('span');
  code.className = 'diff-code';
  code.textContent = text;
  row.appendChild(code);
  return row;
}

// Render git's unified diff: track old/new line numbers from @@ hunk headers,
// colour +/- lines, skip the file-header noise (diff/index/--- /+++).
function renderDiff(text) {
  diffBody.innerHTML = '';
  let oldNo = 0, newNo = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      diffBody.appendChild(diffRow('', '', 'hunk', line));
      continue;
    }
    if (line.startsWith('+')) diffBody.appendChild(diffRow('', newNo++, 'add', line.slice(1)));
    else if (line.startsWith('-')) diffBody.appendChild(diffRow(oldNo++, '', 'del', line.slice(1)));
    else diffBody.appendChild(diffRow(oldNo++, newNo++, 'ctx', line.slice(1)));
  }
}

// Read-only file view for the explorer: reuse the diff container, render each
// line with a single line-number gutter (no +/- colouring).
async function showFile(file) {
  const r = await window.api.readText(file);
  document.getElementById('diff-file').textContent = file;
  let text = r.ok ? r.text : (r.error || '(could not read)');
  if (r.ok && text.includes(' ')) text = '(binary file)'; // ponytail: null-byte sniff is enough
  renderText(text);
  hideAsset();
  hideSessionViews();
  diffView.style.display = 'flex';
}

function renderText(text) {
  diffBody.innerHTML = '';
  // ponytail: cap render at 5000 lines; virtualize only if huge files matter
  const lines = text.split('\n').slice(0, 5000);
  let n = 1;
  for (const line of lines) diffBody.appendChild(diffRow('', n++, '', line));
}

function closeOverlay() {
  if (activeId) selectSession(activeId);
  else { hideDiff(); hideAsset(); emptyHint.style.display = 'block'; }
}
document.getElementById('diff-close').onclick = closeOverlay;
document.getElementById('asset-close').onclick = closeOverlay;

// --- asset view: image zoom / pixel editor / audio waveform ---
const assetView = document.getElementById('asset-view');
const assetBody = document.getElementById('asset-body');
const assetTools = document.getElementById('asset-tools');

// Clearing the body removes any <audio>, stopping playback and freeing memory.
function hideAsset() { assetView.style.display = 'none'; assetBody.innerHTML = ''; assetTools.innerHTML = ''; }

async function showAsset(file, ext) {
  hideDiff();
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

function renderPixelEditor(file, img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const scale = Math.max(1, Math.floor(384 / Math.max(w, h))); // blow tiny art up to ~screen size
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.className = 'pixel-canvas';
  canvas.style.width = (w * scale) + 'px';
  canvas.style.height = (h * scale) + 'px';
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  let color = PALETTE[0];
  let erasing = false;

  const paintAt = (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = Math.floor((e.clientX - rect.left) / scale);
    const py = Math.floor((e.clientY - rect.top) / scale);
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    if (erasing) ctx.clearRect(px, py, 1, 1);
    else { ctx.fillStyle = color; ctx.fillRect(px, py, 1, 1); }
  };
  let down = false;
  canvas.onpointerdown = (e) => { down = true; canvas.setPointerCapture(e.pointerId); paintAt(e); };
  canvas.onpointermove = (e) => { if (down) paintAt(e); };
  canvas.onpointerup = canvas.onpointercancel = () => { down = false; };

  const swatches = document.createElement('div');
  swatches.className = 'palette';
  const eraseBtn = assetBtn('Erase', () => { erasing = !erasing; eraseBtn.classList.toggle('on', erasing); });
  const selectColor = (c) => {
    color = c; erasing = false; eraseBtn.classList.remove('on');
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

  const saved = document.createElement('span');
  saved.className = 'asset-pct';
  const saveBtn = assetBtn('Save', async () => {
    const base64 = canvas.toDataURL('image/png').split(',')[1];
    const r = await window.api.writeAsset(file, base64);
    saved.textContent = r.ok ? 'Saved' : (r.error || 'Save failed');
    if (r.ok) refreshGit();  });

  assetTools.append(swatches, picker, eraseBtn, saveBtn, saved);
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
document.getElementById('git-push').onclick = async () => {
  showGitMsg('Pushing…', true);
  const r = await window.api.gitPush();
  showGitMsg(r.ok ? 'Pushed' : (r.stderr || 'Push failed'), r.ok);
};
document.getElementById('open-folder').onclick = async () => {
  const r = await window.api.openFolder();
  if (!r.canceled) { repoLabel.textContent = r.repo; refreshGit(); }
};

window.addEventListener('resize', () => { if (activeId) fit(sessions.get(activeId)); });

refreshGit();
// ponytail: poll while focused; a file watcher would be more code for no real gain
setInterval(() => { if (document.hasFocus()) refreshGit(); }, 3000);