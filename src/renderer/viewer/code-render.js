// The diff viewer and the read-only file viewer share one DOM container
// (`#diff-view` / `#diff-body`). These refs and the single hide() live here so
// both views target the same element and exactly one place toggles it.
export const diffView = document.getElementById('diff-view');
export const diffBody = document.getElementById('diff-body');
const diffFile = document.getElementById('diff-file');

export function setDiffTitle(file) { diffFile.textContent = file; }
export function hideDiff() { diffView.style.display = 'none'; }
export function showDiffContainer() { diffView.style.display = 'flex'; }
