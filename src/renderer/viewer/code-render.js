// The diff viewer and the file editor share one DOM container (`#diff-view` /
// `#diff-body`). These refs and the single hide() live here so both views target
// the same element and exactly one place toggles it.
export const diffView = document.getElementById('diff-view');
export const diffBody = document.getElementById('diff-body');
const diffFile = document.getElementById('diff-file');
const saveBtn = document.getElementById('diff-save');

export function setDiffTitle(file) { diffFile.textContent = file; }
// Hiding the container also retires the editor's Save button — the file editor
// (file.js) only shows it while a file is mounted; the diff view never does.
export function hideDiff() { diffView.style.display = 'none'; saveBtn.hidden = true; }
export function showDiffContainer() { diffView.style.display = 'flex'; }
