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
