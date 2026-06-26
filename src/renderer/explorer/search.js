import { fileColor } from '../shared/ext.js';
import { openFromTree } from '../viewer/center.js';
import { showTreeContextMenu } from './tree.js';

// Search: filenames first (fast, recursive), then references (git grep, slower)
// streamed in under a "References" heading once they arrive. A run token guards
// against a slow refs response landing after the query already changed.
const fileTree = document.getElementById('file-tree');
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
  // Search hits are always files; reuse the file-tree's context menu.
  row.addEventListener('contextmenu', (ev) => {
    document.querySelectorAll('.tree-row.sel').forEach((x) => x.classList.remove('sel'));
    row.classList.add('sel');
    showTreeContextMenu(ev, file, false);
  });
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
