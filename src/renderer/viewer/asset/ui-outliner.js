import { buildControlTree } from '../../shared/control-layout.js';
import { isControlType } from '../../shared/scene-kind.js';

// The scene tree for the UI editor. Unlike the 3D outliner (model-scene.js's
// buildHierarchy, which is bound to THREE.Object3D) this one is driven purely
// by document paths, so it survives an undo that re-parses the whole document.
// Reuses the .model-tree* chrome so both editors look like one product.

const GLYPHS = [
  [/Container$/, '▤'],
  [/^(Label|RichTextLabel|LinkButton)$/, 'T'],
  [/Button$|^CheckBox$/, '▭'],
  [/^(LineEdit|TextEdit|CodeEdit|SpinBox)$/, '⌶'],
  [/Rect$|^Panel$/, '▧'],
  [/^(HSlider|VSlider|ProgressBar|HScrollBar|VScrollBar)$/, '▬'],
  [/Separator$/, '─'],
  [/2D$/, '◈'],
];

function glyphFor(type, instance) {
  if (instance !== undefined) return '⧉';
  for (const [re, g] of GLYPHS) if (re.test(type || '')) return g;
  return isControlType(type) ? '▢' : '•';
}

export function createOutliner(host, api) {
  const panel = document.createElement('div');
  panel.className = 'model-tree';
  const head = document.createElement('button');
  head.className = 'model-tree-head';
  head.title = 'Toggle scene tree';
  head.innerHTML = '<span class="model-tree-caret">▾</span><span class="model-tree-title">Scene</span>';
  head.addEventListener('click', () => panel.classList.toggle('collapsed'));
  const list = document.createElement('div');
  list.className = 'model-tree-body';
  panel.append(head, list);
  host.appendChild(panel);

  const collapsed = new Set();
  let dragPath = null;
  let renaming = null;

  const isAncestorOrSelf = (maybe, path) => path === maybe || path.startsWith(maybe + '/');

  const makeRow = (entry, depth) => {
    const node = document.createElement('div');
    node.className = 'model-node';
    if (collapsed.has(entry.path)) node.classList.add('collapsed');

    const row = document.createElement('div');
    row.className = 'model-row';
    row.style.paddingLeft = 6 + depth * 12 + 'px';
    row.dataset.path = entry.path;
    if (api.getSelection().includes(entry.path)) row.classList.add('sel');
    const info = api.getLayout().get(entry.path);
    if (info && !info.visible) row.classList.add('hidden');

    const caret = document.createElement('span');
    caret.className = 'model-row-caret';
    caret.textContent = entry.children.length ? '▾' : '';
    if (entry.children.length) {
      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        if (collapsed.has(entry.path)) collapsed.delete(entry.path); else collapsed.add(entry.path);
        rebuild();
      });
    }

    const icon = document.createElement('span');
    icon.className = 'model-row-icon';
    icon.textContent = glyphFor(entry.type, entry.instance);
    icon.title = entry.type || 'instanced scene';

    const label = document.createElement('span');
    label.className = 'model-row-label';
    label.textContent = entry.name;
    label.title = `${entry.name} (${entry.type || 'instance'})`;

    const eye = document.createElement('button');
    eye.className = 'model-row-eye';
    eye.type = 'button';
    eye.textContent = info && info.visible ? '👁' : '⃠';
    eye.title = 'Toggle visibility';
    eye.addEventListener('click', (e) => { e.stopPropagation(); api.onToggleVisible(entry.path); });

    row.append(caret, icon, label, eye);
    row.addEventListener('click', (e) => {
      const sel = api.getSelection();
      if (e.shiftKey || e.ctrlKey) {
        api.setSelection(sel.includes(entry.path) ? sel.filter((p) => p !== entry.path) : [...sel, entry.path]);
      } else api.setSelection([entry.path]);
    });
    row.addEventListener('dblclick', () => startRename(row, label, entry));

    if (entry.path !== '.') {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => { e.stopPropagation(); dragPath = entry.path; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', entry.path); });
      row.addEventListener('dragend', () => { dragPath = null; row.classList.remove('drop-target'); });
    }
    row.addEventListener('dragover', (e) => {
      if (!dragPath || isAncestorOrSelf(dragPath, entry.path)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const child = dragPath;
      dragPath = null;
      if (child && !isAncestorOrSelf(child, entry.path)) api.onReparent(child, entry.path);
    });

    node.appendChild(row);
    if (entry.children.length) {
      const kids = document.createElement('div');
      kids.className = 'model-children';
      for (const c of entry.children) kids.appendChild(makeRow(c, depth + 1));
      node.appendChild(kids);
    }
    return node;
  };

  // Inline rename: the label becomes an input; Enter commits, Escape cancels.
  const startRename = (row, label, entry) => {
    if (renaming) return;
    const input = document.createElement('input');
    input.className = 'uis-rename';
    input.value = entry.name;
    renaming = entry.path;
    label.replaceWith(input);
    input.focus();
    input.select();
    const done = (commit) => {
      if (!renaming) return;
      renaming = null;
      const name = input.value.trim();
      if (commit && name && name !== entry.name) api.onRename(entry.path, name);
      else rebuild();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); }
    });
    input.addEventListener('blur', () => done(true));
  };

  const rebuild = () => {
    if (renaming) return; // an in-flight rename owns the DOM until it settles
    list.innerHTML = '';
    const root = buildControlTree(api.getDoc());
    if (root) list.appendChild(makeRow(root, 0));
  };

  // Selection changed elsewhere (canvas, undo): repaint the highlight only.
  const syncSelection = () => {
    const sel = new Set(api.getSelection());
    for (const row of list.querySelectorAll('.model-row')) {
      row.classList.toggle('sel', sel.has(row.dataset.path));
    }
    const first = list.querySelector('.model-row.sel');
    if (first) first.scrollIntoView({ block: 'nearest' });
  };

  rebuild();
  return { panel, rebuild, syncSelection, destroy: () => panel.remove() };
}

export function startRenameFor(outliner, path) {
  const row = outliner.panel.querySelector(`.model-row[data-path="${CSS.escape(path)}"]`);
  if (row) row.dispatchEvent(new MouseEvent('dblclick'));
}
