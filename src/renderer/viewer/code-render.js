console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval viewer/code-render.js'); // PERF-TEMP
// The diff viewer and the file editor share one DOM container (`#diff-view` /
// `#diff-body`). These refs and the single hide() live here so both views target
// the same element and exactly one place toggles it.
export const diffView = document.getElementById('diff-view');
export const diffBody = document.getElementById('diff-body');
const diffFile = document.getElementById('diff-file');
const saveBtn = document.getElementById('diff-save');
const previewBtn = document.getElementById('diff-preview');
const findBar = document.getElementById('editor-find');
const runSplit = document.getElementById('run-split');
const jsonBar = document.getElementById('editor-json-actions');

export function setDiffTitle(file) { diffFile.textContent = file; }
// Hiding the container also retires the editor's Save/Run buttons and find bar —
// all belong to the file editor (file.js), which only shows them while a file is
// mounted; the diff view never does. clearCenter() routes through here before
// showing any other view, so this is the single place that resets editor chrome.
// Run is also cleared on every show, so switching from a file to a git diff drops
// it; file.js re-shows it after a *runnable* file mounts.
export function hideDiff() {
  diffView.style.display = 'none';
  saveBtn.hidden = true;
  previewBtn.hidden = true;
  findBar.hidden = true;
  runSplit.hidden = true;
  jsonBar.hidden = true;
}
export function showDiffContainer() { diffView.style.display = 'flex'; runSplit.hidden = true; }
