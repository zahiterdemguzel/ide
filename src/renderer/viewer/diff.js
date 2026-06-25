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

// Render git's unified diff: track old/new line numbers from @@ hunk headers,
// colour +/- lines, skip the file-header noise (index/--- /+++/mode/rename...).
// With `fileHeaders` (multi-file commit patches) each `diff --git` emits a file
// header row and re-derives the highlight language from that file's path.
function renderDiff(text, lang, fileHeaders) {
  diffBody.innerHTML = '';
  let oldNo = 0, newNo = 0, curLang = lang;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      if (fileHeaders) {
        const m = /b\/(.+)$/.exec(line);
        const name = m ? m[1] : line.slice('diff --git '.length);
        curLang = langFor(name);
        diffBody.appendChild(fileHeaderRow(name));
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
      diffBody.appendChild(diffRow('', '', 'hunk', line, curLang));
      continue;
    }
    if (line.startsWith('+')) diffBody.appendChild(diffRow('', newNo++, 'add', line.slice(1), curLang));
    else if (line.startsWith('-')) diffBody.appendChild(diffRow(oldNo++, '', 'del', line.slice(1), curLang));
    else diffBody.appendChild(diffRow(oldNo++, newNo++, 'ctx', line.slice(1), curLang));
  }
}
