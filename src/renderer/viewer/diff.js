console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval viewer/diff.js'); // PERF-TEMP
import { diffBody, setDiffTitle, showDiffContainer } from './code-render.js';
import { langFor, hlLine } from '../shared/highlight.js';

// --- diff view ---
// Renders git's unified diff into `#diff-view`. Peer overlays / session
// terminals are hidden by the center coordinator before this is called.
export async function showDiff(file, status, staged) {
  const r = await window.api.gitDiff({ file, staged, untracked: status === '?' });
  setDiffTitle(file);
  renderDiff(r.stdout || r.stderr || '(no changes)', langFor(file));
  showDiffContainer();
}

// Show one historical commit's full patch (History tab → click a commit). The
// patch spans many files, so render per-file headers and pick the language from
// each file's path as we hit its `diff --git` line.
export async function showCommit(hash, subject) {
  const r = await window.api.gitCommitDiff(hash);
  setDiffTitle(subject || hash);
  renderDiff(r.stdout || r.stderr || '(no changes)', null, true);
  showDiffContainer();
}

// Show a stash's full patch (Stashes section → click a stash). Like a commit, it
// spans many files, so render per-file headers and derive the language per path.
export async function showStash(ref, message) {
  const r = await window.api.gitStashShow(ref);
  setDiffTitle(message || ref);
  renderDiff(r.stdout || r.stderr || '(no changes)', null, true);
  showDiffContainer();
}

function fileHeaderRow(name) {
  const row = document.createElement('div');
  row.className = 'diff-row file';
  const code = document.createElement('span');
  code.className = 'diff-code';
  code.textContent = name;
  row.appendChild(code);
  return row;
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

// Render git's unified diff into the shared center diff body.
function renderDiff(text, lang, fileHeaders) { renderDiffInto(diffBody, text, lang, fileHeaders); }

// Render git's unified diff into `body`: track old/new line numbers from @@ hunk
// headers, colour +/- lines, skip the file-header noise (index/--- /+++/mode/
// rename...). With `fileHeaders` (multi-file patches — commits and per-session
// diffs) each `diff --git` emits a file header row and re-derives the highlight
// language from that file's path. Exported so the per-session Diff dialog can
// render into its own panel without going through the center diff overlay.
export function renderDiffInto(body, text, lang, fileHeaders) {
  body.innerHTML = '';
  let oldNo = 0, newNo = 0, curLang = lang;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (fileHeaders) {
        const m = /b\/(.+)$/.exec(line);
        const name = m ? m[1] : line.slice('diff --git '.length);
        curLang = langFor(name);
        body.appendChild(fileHeaderRow(name));
      }
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity ') || line.startsWith('dissimilarity ') ||
        line.startsWith('rename ') || line.startsWith('copy ')) continue;
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      body.appendChild(diffRow('', '', 'hunk', line, curLang));
      continue;
    }
    if (line.startsWith('+')) body.appendChild(diffRow('', newNo++, 'add', line.slice(1), curLang));
    else if (line.startsWith('-')) body.appendChild(diffRow(oldNo++, '', 'del', line.slice(1), curLang));
    else body.appendChild(diffRow(oldNo++, newNo++, 'ctx', line.slice(1), curLang));
  }
}

// One half of a side-by-side row. `cell` is { no, cls, text } or null (an empty
// gutter on the side that has no counterpart line).
function sbsSide(cell, lang) {
  const side = document.createElement('div');
  side.className = 'sbs-side ' + (cell ? cell.cls : 'empty');
  if (!cell) return side;
  const ln = document.createElement('span');
  ln.className = 'diff-ln';
  ln.textContent = cell.no || '';
  const code = document.createElement('span');
  code.className = 'diff-code';
  const hl = hlLine(cell.text, lang);
  if (hl != null) code.innerHTML = hl; else code.textContent = cell.text;
  side.append(ln, code);
  return side;
}

function sbsRow(left, right, lang) {
  const row = document.createElement('div');
  row.className = 'sbs-row';
  row.append(sbsSide(left, lang), sbsSide(right, lang));
  return row;
}

function sbsFullRow(cls, text) {
  const row = document.createElement('div');
  row.className = 'sbs-row ' + cls;
  const code = document.createElement('span');
  code.className = 'diff-code';
  code.textContent = text;
  row.appendChild(code);
  return row;
}

// Render git's unified diff as a two-column (old | new) side-by-side view. Within
// a hunk, consecutive deletions and additions are paired row-for-row (del on the
// left, add on the right); an unpaired del/add leaves the opposite side blank.
// Context lines appear on both sides. File headers and @@ hunk headers span the
// full width. `fileHeaders` is implied (a per-session/commit patch spans files).
export function renderDiffSplitInto(body, text, lang) {
  body.innerHTML = '';
  let oldNo = 0, newNo = 0, curLang = lang;
  let pendDel = [], pendAdd = [];
  const flush = () => {
    const n = Math.max(pendDel.length, pendAdd.length);
    for (let i = 0; i < n; i++) body.appendChild(sbsRow(pendDel[i] || null, pendAdd[i] || null, curLang));
    pendDel = []; pendAdd = [];
  };
  for (const line of text.split('\n')) {
    if (line === '') continue; // trailing split artifact
    if (line.startsWith('diff --git')) {
      flush();
      const m = /b\/(.+)$/.exec(line);
      const name = m ? m[1] : line.slice('diff --git '.length);
      curLang = langFor(name);
      body.appendChild(sbsFullRow('file', name));
      continue;
    }
    if (line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ') ||
        line.startsWith('new file') || line.startsWith('deleted file') ||
        line.startsWith('old mode') || line.startsWith('new mode') ||
        line.startsWith('similarity ') || line.startsWith('dissimilarity ') ||
        line.startsWith('rename ') || line.startsWith('copy ')) continue;
    if (line.startsWith('@@')) {
      flush();
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) { oldNo = +m[1]; newNo = +m[2]; }
      body.appendChild(sbsFullRow('hunk', line));
      continue;
    }
    if (line.startsWith('+')) { pendAdd.push({ no: newNo++, cls: 'add', text: line.slice(1) }); continue; }
    if (line.startsWith('-')) { pendDel.push({ no: oldNo++, cls: 'del', text: line.slice(1) }); continue; }
    // context line: flush any pending del/add block, then show it on both sides
    flush();
    const t = line.slice(1);
    body.appendChild(sbsRow({ no: oldNo++, cls: 'ctx', text: t }, { no: newNo++, cls: 'ctx', text: t }, curLang));
  }
  flush();
}
