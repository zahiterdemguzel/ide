import { fileColor } from '../shared/ext.js';
import { openFromTree } from '../viewer/center.js';
import { promptText } from '../shared/prompt.js';
import { confirmDialog } from '../shared/confirm.js';
import { sendToActiveSession } from '../sessions.js';

// --- file explorer (left, below sessions) ---
// Lazy tree: each folder fetches its children the first time it's expanded.
const fileTree = document.getElementById('file-tree');

// Last clicked tree item, used as the anchor for "New file". Survives a tree
// rebuild (refreshTree) since it stores the path, not the DOM row.
let selected = null; // { rel, dir }
function select(row, rel, dir) {
  fileTree.querySelectorAll('.tree-row.sel').forEach((x) => x.classList.remove('sel'));
  row.classList.add('sel');
  selected = { rel, dir };
}

// --- context menu ---
const ctxMenu = document.createElement('div');
ctxMenu.id = 'tree-ctx-menu';
ctxMenu.innerHTML =
  '<button data-action="rename"><span class="ctx-icon">✎</span>Rename</button>' +
  '<button data-action="add-to-chat"><span class="ctx-icon">＠</span>Add to chat</button>' +
  '<button data-action="copy-path"><span class="ctx-icon">⧉</span>Copy path</button>' +
  '<div class="ctx-sep"></div>' +
  '<button data-action="delete" class="ctx-danger"><span class="ctx-icon">🗑</span>Delete</button>';
document.body.appendChild(ctxMenu);

let ctxTarget = null; // { rel, dir }

function hideCtxMenu() { ctxMenu.style.display = 'none'; ctxTarget = null; }

function showCtxMenu(x, y, rel, dir) {
  ctxTarget = { rel, dir };
  ctxMenu.style.cssText = `display:block; position:fixed; left:${x}px; top:${y}px;`;
  requestAnimationFrame(() => {
    const r = ctxMenu.getBoundingClientRect();
    if (r.right > window.innerWidth) ctxMenu.style.left = (window.innerWidth - r.width - 4) + 'px';
    if (r.bottom > window.innerHeight) ctxMenu.style.top = (window.innerHeight - r.height - 4) + 'px';
  });
}

document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

ctxMenu.addEventListener('click', async (e) => {
  e.stopPropagation();
  const btn = e.target.closest('[data-action]');
  if (!btn || !ctxTarget) return;
  const { rel, dir } = ctxTarget;
  hideCtxMenu();

  if (btn.dataset.action === 'rename') {
    const parts = rel.split('/');
    const oldName = parts[parts.length - 1];
    const newName = await promptText({ title: 'Rename', label: 'New name', placeholder: oldName, value: oldName, ok: 'Rename' });
    if (!newName || newName === oldName) return;
    const newRel = parts.slice(0, -1).concat(newName).join('/');
    const r = await window.api.renameFile(rel, newRel);
    if (!r.ok) {
      await confirmDialog({ title: 'Rename failed', message: r.error || 'Could not rename.', ok: 'OK' });
      return;
    }
    if (selected && selected.rel === rel) selected = { rel: newRel, dir };
    await refreshTree();

  } else if (btn.dataset.action === 'delete') {
    const okToDelete = await confirmDialog({
      title: dir ? 'Delete folder?' : 'Delete file?',
      message: dir
        ? `Move "${rel}" and everything inside it to the Recycle Bin?`
        : `Move "${rel}" to the Recycle Bin?`,
      ok: 'Delete',
      danger: true,
    });
    if (!okToDelete) return;
    const r = await window.api.deleteFile(rel);
    if (!r.ok) {
      await confirmDialog({ title: 'Delete failed', message: r.error || 'Could not delete.', ok: 'OK' });
      return;
    }
    if (selected && selected.rel === rel) selected = null;
    await refreshTree();

  } else if (btn.dataset.action === 'add-to-chat') {
    sendToActiveSession('@' + rel);

  } else if (btn.dataset.action === 'copy-path') {
    await navigator.clipboard.writeText(rel);
  }
});

async function loadDir(rel, container, depth, expandedSet = null) {
  const r = await window.api.listDir(rel);
  container.innerHTML = '';
  if (!r.ok) return;
  for (const e of r.entries) {
    const childRel = rel ? rel + '/' + e.name : e.name;
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.rel = childRel;
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

    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      select(row, childRel, e.dir);
      showCtxMenu(ev.clientX, ev.clientY, childRel, e.dir);
    });

    if (e.dir) {
      const kids = document.createElement('div');
      kids.style.display = 'none';
      container.appendChild(kids);
      let loaded = false;
      row.onclick = async () => {
        select(row, childRel, true);
        const open = kids.style.display === 'none';
        kids.style.display = open ? 'block' : 'none';
        twist.textContent = open ? '▾' : '▸';
        if (open && !loaded) { loaded = true; await loadDir(childRel, kids, depth + 1); }
      };
      // Restore previously-expanded state after a tree rebuild.
      if (expandedSet && expandedSet.has(childRel)) {
        kids.style.display = 'block';
        twist.textContent = '▾';
        loaded = true;
        await loadDir(childRel, kids, depth + 1, expandedSet);
      }
    } else {
      row.draggable = true;
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer.setData('text/plain', '@' + childRel);
        ev.dataTransfer.effectAllowed = 'copy';
      });
      row.onclick = () => {
        select(row, childRel, false);
        openFromTree(childRel);
      };
    }
  }
}

export async function refreshTree() {
  // Capture which folders are currently open so we can restore them after the rebuild.
  const expanded = new Set(
    [...fileTree.querySelectorAll('.tree-row')]
      .filter(row => row.querySelector('.tree-twist')?.textContent === '▾')
      .map(row => row.dataset.rel)
      .filter(Boolean)
  );
  await loadDir('', fileTree, 0, expanded.size ? expanded : null);
  // Re-apply the selection highlight (select() cleared it when the DOM was wiped).
  if (selected) {
    for (const row of fileTree.querySelectorAll('.tree-row')) {
      if (row.dataset.rel === selected.rel) { row.classList.add('sel'); break; }
    }
  }
}
document.getElementById('files-refresh').onclick = refreshTree;

// Where a new file lands: inside the selected folder, alongside the selected
// file, or at the repo root when nothing is selected.
function targetDir() {
  if (!selected) return '';
  if (selected.dir) return selected.rel;
  const slash = selected.rel.lastIndexOf('/');
  return slash === -1 ? '' : selected.rel.slice(0, slash);
}

document.getElementById('files-new').onclick = async () => {
  const dir = targetDir();
  let error = '';
  for (;;) {
    const name = await promptText({
      title: 'New file',
      label: dir ? `Create in ${dir}/` : 'Create at repo root',
      placeholder: 'run.py',
      error,
    });
    if (!name) return;
    const rel = dir ? dir + '/' + name : name;
    const r = await window.api.createFile(rel);
    if (r.ok) { await refreshTree(); openFromTree(r.rel); return; }
    error = r.error || 'Could not create file';
  }
};

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
