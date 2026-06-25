import { fileColor } from '../shared/ext.js';
import { openFromTree } from '../viewer/center.js';

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

export function refreshTree() { loadDir('', fileTree, 0); }
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
